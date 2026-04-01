import { eq, ne, desc, sql, and, gte, lte, like, count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import path from "path";
import {
  InsertUser,
  users,
  materials,
  materialChunks,
  queries,
  llmConfigs,
  visitorStats,
  uploadSessions,
  queryFeedback,
  type InsertMaterial,
  type InsertMaterialChunk,
  type InsertQuery,
  type InsertLlmConfig,
  type InsertUploadSession,
  type QuerySource,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const mysql = await import("mysql2/promise");
      const pool = mysql.createPool({
        uri: process.env.DATABASE_URL,
        connectionLimit: 10,
        connectTimeout: 10000,
        charset: "utf8mb4",
      });
      _db = drizzle(pool);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function runMigrations() {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot run migrations: database not available");
    return;
  }
  const migrationsFolder = path.resolve(process.cwd(), "drizzle");
  await migrate(db, { migrationsFolder });
  await ensureSchemaColumns();
  await ensureRetrievalIndexes();
}

/** Idempotently ensure columns that may have been missed by Drizzle migrations. */
async function ensureSchemaColumns() {
  const db = await getDb();
  if (!db) return;

  const wantedColumns: { table: string; column: string; ddl: string }[] = [
    {
      table: "material_chunks",
      column: "startOffset",
      ddl: "ALTER TABLE `material_chunks` ADD COLUMN `startOffset` int DEFAULT NULL",
    },
    {
      table: "material_chunks",
      column: "endOffset",
      ddl: "ALTER TABLE `material_chunks` ADD COLUMN `endOffset` int DEFAULT NULL",
    },
    {
      table: "queries",
      column: "conversationId",
      ddl: "ALTER TABLE `queries` ADD COLUMN `conversationId` varchar(64) DEFAULT NULL",
    },
  ];

  try {
    // Use query() not execute() — DDL and INFORMATION_SCHEMA don't work with prepared statements
    const [rows] = await (db as any).$client.query(`
      SELECT TABLE_NAME as t, COLUMN_NAME as c
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('material_chunks', 'queries')
        AND COLUMN_NAME IN ('startOffset', 'endOffset', 'conversationId')
    `);
    const existing = new Set<string>();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        existing.add(`${row.t}:${row.c}`);
      }
    }
    for (const item of wantedColumns) {
      if (existing.has(`${item.table}:${item.column}`)) continue;
      try {
        await (db as any).$client.query(item.ddl);
        console.log(`[Database] Added column ${item.table}.${item.column}`);
      } catch (err) {
        console.warn(`[Database] Failed to add column ${item.table}.${item.column}:`, err);
      }
    }
    // Ensure index on queries.conversationId
    if (!existing.has("queries:conversationId")) {
      try {
        await (db as any).$client.query(
          "CREATE INDEX `queries_conversationId_idx` ON `queries` (`conversationId`)"
        );
      } catch (_e) { /* already exists */ }
    }
  } catch (err) {
    console.warn("[Database] ensureSchemaColumns failed:", err);
  }
}

async function ensureRetrievalIndexes() {
  const db = await getDb();
  if (!db) return;

  const wantedIndexes = [
    {
      table: "material_chunks",
      name: "idx_material_chunks_material_chunk",
      ddl: "CREATE INDEX `idx_material_chunks_material_chunk` ON `material_chunks` (`materialId`, `chunkIndex`)",
    },
    {
      table: "material_chunks",
      name: "idx_material_chunks_material_vector",
      ddl: "CREATE INDEX `idx_material_chunks_material_vector` ON `material_chunks` (`materialId`, `vectorId`)",
    },
    {
      table: "materials",
      name: "idx_materials_status_language",
      ddl: "CREATE INDEX `idx_materials_status_language` ON `materials` (`status`, `language`)",
    },
    {
      table: "material_chunks",
      name: "ft_material_chunks_content_chapter",
      ddl: "CREATE FULLTEXT INDEX `ft_material_chunks_content_chapter` ON `material_chunks` (`content`, `chapter`)",
    },
  ] as const;

  try {
    const [rows] = await (db as any).$client.query(`
      SELECT TABLE_NAME as tableName, INDEX_NAME as indexName
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('material_chunks', 'materials')
    `);

    const existing = new Set<string>();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const tableName = String((row as any).tableName ?? "");
        const indexName = String((row as any).indexName ?? "");
        if (tableName && indexName) existing.add(`${tableName}:${indexName}`);
      }
    }

    for (const item of wantedIndexes) {
      const key = `${item.table}:${item.name}`;
      if (existing.has(key)) continue;
      try {
        await (db as any).$client.query(item.ddl);
        console.log(`[Database] Created index ${item.name}`);
      } catch (error) {
        console.warn(`[Database] Failed to create index ${item.name}:`, error);
      }
    }
  } catch (error) {
    console.warn("[Database] Failed to inspect/create retrieval indexes:", error);
  }
}

// ─── Users ────────────────────────────────────────────────────────────────────
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }

  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;

    textFields.forEach((field) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    });

    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ─── Materials ────────────────────────────────────────────────────────────────
// Helper: Drizzle with mysql2 driver returns [ResultSetHeader, FieldPacket[]]
// insertId lives on result[0].insertId
function extractInsertId(result: unknown): number {
  // Drizzle mysql2: result is [ResultSetHeader, ...] or ResultSetHeader directly
  const header = Array.isArray(result) ? result[0] : result;
  const id = (header as any)?.insertId;
  if (id === undefined || id === null || isNaN(Number(id))) {
    throw new Error(`[DB] insertId is invalid: ${JSON.stringify(id)}`);
  }
  return Number(id);
}

export async function createMaterial(data: InsertMaterial) {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");
  const result = await db.insert(materials).values(data);
  return extractInsertId(result);
}

export async function getMaterials() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(materials).orderBy(desc(materials.createdAt));
}

export async function getMaterialById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(materials).where(eq(materials.id, id)).limit(1);
  return result[0];
}

export async function updateMaterialStatus(
  id: number,
  status: "uploading" | "processing" | "published" | "error",
  extra?: { errorMessage?: string; totalChunks?: number }
) {
  const db = await getDb();
  if (!db) return;
  await db.update(materials).set({ status, ...extra }).where(eq(materials.id, id));
}

export async function deleteMaterial(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(materialChunks).where(eq(materialChunks.materialId, id));
  await db.delete(materials).where(eq(materials.id, id));
}

export async function deleteChunksByMaterialId(materialId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(materialChunks).where(eq(materialChunks.materialId, materialId));
}

// ─── Material Chunks ──────────────────────────────────────────────────────────
export async function insertMaterialChunk(data: InsertMaterialChunk): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");
  const result = await db.insert(materialChunks).values(data);
  return extractInsertId(result);
}

export async function getChunksByMaterialId(materialId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(materialChunks).where(eq(materialChunks.materialId, materialId));
}

// ─── Queries ──────────────────────────────────────────────────────────────────
export async function createQuery(data: InsertQuery): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");
  const result = await db.insert(queries).values(data);
  return extractInsertId(result);
}

export async function getRecentQueries(limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(queries).orderBy(desc(queries.createdAt)).limit(limit);
}

export async function getQueryStats() {
  const db = await getDb();
  if (!db) return { total: 0, today: 0 };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [totalResult, todayResult] = await Promise.all([
    db.select({ count: count() }).from(queries),
    db.select({ count: count() }).from(queries).where(gte(queries.createdAt, today)),
  ]);

  return {
    total: totalResult[0]?.count || 0,
    today: todayResult[0]?.count || 0,
  };
}

export async function submitQueryFeedback(queryId: number, helpful: boolean) {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");
  await db.insert(queryFeedback).values({
    queryId,
    helpful: helpful ? 1 : 0,
    createdAt: Date.now(),
  });
}

export async function getLowRatedQuestions() {
  const db = await getDb();
  if (!db) return [];
  const [rows] = await (db as any).$client.execute(`
    SELECT q.id, q.question, q.answer, q.createdAt as created_at,
           COUNT(f.id) as total_feedback,
           SUM(CASE WHEN f.helpful = 0 THEN 1 ELSE 0 END) as unhelpful_count,
           ROUND(SUM(CASE WHEN f.helpful = 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(f.id), 1) as unhelpful_rate
    FROM queries q
    JOIN query_feedback f ON f.query_id = q.id
    GROUP BY q.id
    HAVING total_feedback >= 2 AND unhelpful_rate > 50
    ORDER BY unhelpful_count DESC
    LIMIT 20
  `);
  return rows as any[];
}

export async function getTopQuestions(limit = 10) {
  const db = await getDb();
  if (!db) return [];
  // 获取最近 500 条查询，在应用层统计热门问题
  const recent = await db
    .select({ question: queries.question })
    .from(queries)
    .orderBy(desc(queries.createdAt))
    .limit(500);

  const freq = new Map<string, number>();
  recent.forEach(({ question }) => {
    const key = question.trim().substring(0, 100);
    freq.set(key, (freq.get(key) || 0) + 1);
  });

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([question, count]) => ({ question, count }));
}

export async function getMaterialUsageStats() {
  const db = await getDb();
  if (!db) return [];

  const allMaterials = await db.select({ id: materials.id, title: materials.title }).from(materials);
  const allQueries = await db.select({ sources: queries.sources }).from(queries).limit(1000);

  const usageMap = new Map<number, number>();
  allQueries.forEach(({ sources }) => {
    if (!sources) return;
    const sourceList = sources as QuerySource[];
    sourceList.forEach((s) => {
      usageMap.set(s.materialId, (usageMap.get(s.materialId) || 0) + 1);
    });
  });

  return allMaterials
    .map((m) => ({ id: m.id, title: m.title, usageCount: usageMap.get(m.id) || 0 }))
    .sort((a, b) => b.usageCount - a.usageCount);
}

// ─── LLM Configs ──────────────────────────────────────────────────────────────
export async function getLlmConfigs() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(llmConfigs).orderBy(desc(llmConfigs.createdAt));
}

export async function getActiveLlmConfig() {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(llmConfigs).where(eq(llmConfigs.isActive, true)).limit(1);
  return result[0];
}

export async function createLlmConfig(data: InsertLlmConfig): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");
  const result = await db.insert(llmConfigs).values(data);
  return extractInsertId(result);
}

export async function updateLlmConfig(id: number, data: Partial<InsertLlmConfig>) {
  const db = await getDb();
  if (!db) return;
  await db.update(llmConfigs).set(data).where(eq(llmConfigs.id, id));
}

export async function setActiveLlmConfig(id: number) {
  const db = await getDb();
  if (!db) return;
  // 单条 SQL：取消非目标配置的激活状态
  await db.update(llmConfigs).set({ isActive: false }).where(ne(llmConfigs.id, id));
  // 激活指定配置
  await db.update(llmConfigs).set({ isActive: true }).where(eq(llmConfigs.id, id));
}

export async function deleteLlmConfig(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(llmConfigs).where(eq(llmConfigs.id, id));
}

// ─── Visitor Stats ────────────────────────────────────────────────────────────
export async function upsertVisitorStat(
  date: string,
  cityDistribution?: Record<string, number>,
  countryDistribution?: Record<string, number>
) {
  const db = await getDb();
  if (!db) return;

  const existing = await db
    .select()
    .from(visitorStats)
    .where(eq(visitorStats.date, date))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(visitorStats).values({
      date,
      totalVisitors: 1,
      totalQueries: 1,
      cityDistribution: cityDistribution || {},
      countryDistribution: countryDistribution || {},
    });
  } else {
    const current = existing[0];
    const newCity = mergeDistribution(
      (current.cityDistribution as Record<string, number>) || {},
      cityDistribution || {}
    );
    const newCountry = mergeDistribution(
      (current.countryDistribution as Record<string, number>) || {},
      countryDistribution || {}
    );
    await db
      .update(visitorStats)
      .set({
        totalVisitors: (current.totalVisitors || 0) + 1,
        totalQueries: (current.totalQueries || 0) + 1,
        cityDistribution: newCity,
        countryDistribution: newCountry,
      })
      .where(eq(visitorStats.date, date));
  }
}

export async function getVisitorStats(days = 30) {
  const db = await getDb();
  if (!db) return [];
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split("T")[0];
  return db
    .select()
    .from(visitorStats)
    .where(gte(visitorStats.date, sinceStr))
    .orderBy(desc(visitorStats.date));
}

function mergeDistribution(
  a: Record<string, number>,
  b: Record<string, number>
): Record<string, number> {
  const result = { ...a };
  Object.entries(b).forEach(([key, val]) => {
    result[key] = (result[key] || 0) + val;
  });
  return result;
}

// ─── Upload Sessions ──────────────────────────────────────────────────────────
export async function createUploadSession(data: InsertUploadSession) {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");
  await db.insert(uploadSessions).values(data);
  return data.id;
}

export async function getUploadSession(id: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)).limit(1);
  return result[0];
}

export async function updateUploadSession(id: string, data: Partial<InsertUploadSession>) {
  const db = await getDb();
  if (!db) return;
  await db.update(uploadSessions).set(data).where(eq(uploadSessions.id, id));
}

// ─── 数据库存储统计与清理 ─────────────────────────────────────────────────────

/** 获取各表的行数和数据库大小 */
export async function getStorageStats() {
  const db = await getDb();
  if (!db) return null;

  // 获取各表行数
  const [chunkCount] = await db.select({ count: count() }).from(materialChunks);
  const [queryCount] = await db.select({ count: count() }).from(queries);
  const [sessionCount] = await db.select({ count: count() }).from(uploadSessions);
  const [feedbackCount] = await db.select({ count: count() }).from(queryFeedback);
  const [materialCount] = await db.select({ count: count() }).from(materials);

  // 获取数据库总大小（MB）
  const sizeResult = await db.execute(sql`
    SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS totalMB,
           TABLE_NAME as tableName,
           ROUND((data_length + index_length) / 1024 / 1024, 2) AS tableMB
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
    GROUP BY TABLE_NAME
    ORDER BY (data_length + index_length) DESC
  `);

  return {
    tables: {
      materialChunks: chunkCount.count,
      queries: queryCount.count,
      uploadSessions: sessionCount.count,
      queryFeedback: feedbackCount.count,
      materials: materialCount.count,
    },
    tableSizes: (sizeResult as unknown as [{ tableName: string; tableMB: string }[]]).at(0) ?? [],
  };
}

/** 清理旧查询记录（保留最近 N 天） */
export async function purgeOldQueries(retainDays: number) {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retainDays);
  const result = await db.delete(queries).where(lte(queries.createdAt, cutoff));
  return (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
}

/** 清理已完成的上传会话 */
export async function purgeCompletedUploadSessions() {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.delete(uploadSessions).where(
    eq(uploadSessions.status, "completed")
  );
  return (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
}

/** 清空所有 embedding 数据（释放大量空间）*/
export async function clearAllEmbeddings() {
  const db = await getDb();
  if (!db) return;
  await db.update(materialChunks).set({ embedding: null });
}
