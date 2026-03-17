import {
  int,
  tinyint,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  float,
  json,
  boolean,
  bigint,
} from "drizzle-orm/mysql-core";

// ─── Users ───────────────────────────────────────────────────────────────────
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Materials (教材元数据) ─────────────────────────────────────────────────
export const materials = mysqlTable("materials", {
  id: int("id").autoincrement().primaryKey(),
  title: varchar("title", { length: 512 }).notNull(),
  author: varchar("author", { length: 256 }),
  publisher: varchar("publisher", { length: 256 }),
  publishYear: varchar("publishYear", { length: 16 }),
  edition: varchar("edition", { length: 64 }),
  fileKey: varchar("fileKey", { length: 1024 }).notNull(),   // S3 key
  fileUrl: text("fileUrl").notNull(),                        // S3 public URL
  fileSizeBytes: bigint("fileSizeBytes", { mode: "number" }),
  status: mysqlEnum("status", ["uploading", "processing", "published", "error"])
    .default("uploading")
    .notNull(),
  errorMessage: text("errorMessage"),
  totalChunks: int("totalChunks").default(0),
  language: mysqlEnum("language", ["zh", "en"]).default("zh").notNull(),
  uploadedBy: int("uploadedBy"),                             // FK → users.id
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Material = typeof materials.$inferSelect;
export type InsertMaterial = typeof materials.$inferInsert;

// ─── Material Chunks (教材内容块 + 向量ID映射) ─────────────────────────────
export const materialChunks = mysqlTable("material_chunks", {
  id: int("id").autoincrement().primaryKey(),
  materialId: int("materialId").notNull(),                   // FK → materials.id
  chunkIndex: int("chunkIndex").notNull(),
  content: text("content").notNull(),                        // 原始文本块
  chapter: varchar("chapter", { length: 512 }),              // 章节标题
  pageStart: int("pageStart"),                               // 起始页码
  pageEnd: int("pageEnd"),                                   // 结束页码
  vectorId: varchar("vectorId", { length: 256 }),            // Milvus/向量库中的ID
  tokenCount: int("tokenCount"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type MaterialChunk = typeof materialChunks.$inferSelect;
export type InsertMaterialChunk = typeof materialChunks.$inferInsert;

// ─── Queries (查询记录 + 引用来源) ─────────────────────────────────────────
export const queries = mysqlTable("queries", {
  id: int("id").autoincrement().primaryKey(),
  question: text("question").notNull(),
  answer: text("answer"),
  // JSON array of { materialId, materialTitle, chapter, pageStart, pageEnd, excerpt }
  sources: json("sources").$type<QuerySource[]>(),
  modelUsed: varchar("modelUsed", { length: 128 }),
  responseTimeMs: int("responseTimeMs"),
  visitorIp: varchar("visitorIp", { length: 64 }),
  visitorCity: varchar("visitorCity", { length: 128 }),
  visitorRegion: varchar("visitorRegion", { length: 128 }),
  visitorCountry: varchar("visitorCountry", { length: 64 }),
  visitorLat: float("visitorLat"),
  visitorLng: float("visitorLng"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type QuerySource = {
  materialId: number;
  materialTitle: string;
  chapter: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  excerpt: string;
  highlightedExcerpt?: string;
};

export type Query = typeof queries.$inferSelect;
export type InsertQuery = typeof queries.$inferInsert;

// ─── LLM Configs (模型配置) ────────────────────────────────────────────────
export const llmConfigs = mysqlTable("llm_configs", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),          // 配置名称，如"DeepSeek生产"
  provider: mysqlEnum("provider", [
    "openai",
    "deepseek",
    "qwen",
    "ollama",
    "custom",
  ]).notNull(),
  modelName: varchar("modelName", { length: 128 }).notNull(),// 模型名称，如"deepseek-chat"
  apiKey: text("apiKey"),                                    // 加密存储
  apiBaseUrl: text("apiBaseUrl"),                            // 自定义 Base URL
  temperature: float("temperature").default(0.1),
  maxTokens: int("maxTokens").default(4096),
  embeddingModel: varchar("embeddingModel", { length: 128 }), // 用于向量化的模型
  embeddingApiKey: text("embeddingApiKey"),
  embeddingBaseUrl: text("embeddingBaseUrl"),
  isActive: boolean("isActive").default(false).notNull(),    // 当前激活的配置
  isDefault: boolean("isDefault").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type LlmConfig = typeof llmConfigs.$inferSelect;
export type InsertLlmConfig = typeof llmConfigs.$inferInsert;

// ─── Visitor Stats (访客统计，按天聚合) ────────────────────────────────────
export const visitorStats = mysqlTable("visitor_stats", {
  id: int("id").autoincrement().primaryKey(),
  date: varchar("date", { length: 16 }).notNull(),           // YYYY-MM-DD
  totalVisitors: int("totalVisitors").default(0).notNull(),
  totalQueries: int("totalQueries").default(0).notNull(),
  // JSON: { "北京": 12, "上海": 8, ... }
  cityDistribution: json("cityDistribution").$type<Record<string, number>>(),
  countryDistribution: json("countryDistribution").$type<Record<string, number>>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type VisitorStat = typeof visitorStats.$inferSelect;
export type InsertVisitorStat = typeof visitorStats.$inferInsert;

// ─── Upload Sessions (大文件分块上传会话) ──────────────────────────────────
export const uploadSessions = mysqlTable("upload_sessions", {
  id: varchar("id", { length: 64 }).primaryKey(),            // nanoid
  materialId: int("materialId"),                             // 创建后关联
  filename: varchar("filename", { length: 512 }).notNull(),
  totalSize: bigint("totalSize", { mode: "number" }).notNull(),
  totalChunks: int("totalChunks").notNull(),
  uploadedChunks: int("uploadedChunks").default(0).notNull(),
  s3UploadId: varchar("s3UploadId", { length: 512 }),        // S3 multipart upload ID
  s3Parts: json("s3Parts").$type<S3Part[]>(),               // 已上传分块 ETag 列表
  status: mysqlEnum("status", ["active", "completed", "aborted"])
    .default("active")
    .notNull(),
  createdBy: int("createdBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type S3Part = { partNumber: number; etag: string };
export type UploadSession = typeof uploadSessions.$inferSelect;
export type InsertUploadSession = typeof uploadSessions.$inferInsert;

// ─── Query Feedback (答案反馈) ───────────────────────────────────────────────
export const queryFeedback = mysqlTable("query_feedback", {
  id: int("id").primaryKey().autoincrement(),
  queryId: int("query_id").notNull(),
  helpful: tinyint("helpful").notNull(), // 1=有帮助, 0=没帮助
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});
