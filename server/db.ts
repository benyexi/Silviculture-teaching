import { eq, desc, sql, and, gte, lte, like, count } from "drizzle-orm";
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
  // 先取消所有激活状态
  await db.update(llmConfigs).set({ isActive: false });
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
