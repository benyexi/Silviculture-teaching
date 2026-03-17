/**
 * 向量检索服务
 * 由于 Milvus 需要独立部署，本实现使用 MySQL 存储向量（JSON 列），
 * 通过余弦相似度在应用层计算相似性。
 * 对于 10 本教材（约 5000-10000 个 chunk），此方案完全满足性能需求。
 * 如需升级到 Milvus，只需替换本文件中的存储和检索逻辑。
 */
import { getDb } from "./db";
import { materialChunks, materials } from "../drizzle/schema";
import { eq, inArray } from "drizzle-orm";
import { getEmbedding, cosineSimilarity } from "./llmDriver";

// ─── 向量存储表（独立存储，避免 materialChunks 表过大）─────────────────────
// 向量以 JSON 数组形式存储在 vectorData 列（在 materialChunks 的 vectorId 字段中存储索引）

// ─── 检索结果类型 ─────────────────────────────────────────────────────────────
export type SearchResult = {
  chunkId: number;
  materialId: number;
  materialTitle: string;
  chapter: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  content: string;
  similarity: number;
};

// ─── 内存向量缓存（避免每次查询都从 DB 读取所有向量）────────────────────────
type VectorCacheEntry = {
  chunkId: number;
  materialId: number;
  vector: number[];
  lastUpdated: number;
};

let vectorCache: VectorCacheEntry[] = [];
let cacheLastRefreshed = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

// ─── 向量存储（存储到 chunk 的 vectorId 字段，实际向量存在独立 JSON 文件）──
// 为简化部署，向量数据存储在数据库的 TEXT 列中（base64 编码的 Float32Array）

export async function storeChunkVector(
  chunkId: number,
  vector: number[]
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");

  // 将向量序列化为 base64 字符串存储
  const vectorJson = JSON.stringify(vector);
  const vectorId = `chunk_${chunkId}`;

  await db
    .update(materialChunks)
    .set({ vectorId: vectorJson })
    .where(eq(materialChunks.id, chunkId));

  // 更新内存缓存
  const existingIdx = vectorCache.findIndex((e) => e.chunkId === chunkId);
  const entry: VectorCacheEntry = {
    chunkId,
    materialId: 0, // 稍后填充
    vector,
    lastUpdated: Date.now(),
  };
  if (existingIdx >= 0) {
    vectorCache[existingIdx] = entry;
  } else {
    vectorCache.push(entry);
  }
}

// ─── 刷新向量缓存 ─────────────────────────────────────────────────────────────
async function refreshVectorCache(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const chunks = await db
    .select({
      id: materialChunks.id,
      materialId: materialChunks.materialId,
      vectorId: materialChunks.vectorId,
    })
    .from(materialChunks)
    .where(eq(materialChunks.vectorId, materialChunks.vectorId)); // 只取有向量的

  vectorCache = chunks
    .filter((c) => c.vectorId && c.vectorId.startsWith("["))
    .map((c) => ({
      chunkId: c.id,
      materialId: c.materialId,
      vector: JSON.parse(c.vectorId!) as number[],
      lastUpdated: Date.now(),
    }));

  cacheLastRefreshed = Date.now();
}

// ─── 语义检索 Top-K ───────────────────────────────────────────────────────────
export async function semanticSearch(
  question: string,
  topK: number = 5,
  materialIds?: number[]
): Promise<SearchResult[]> {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");

  // 刷新缓存（如果过期）
  if (Date.now() - cacheLastRefreshed > CACHE_TTL_MS) {
    await refreshVectorCache();
  }

  if (vectorCache.length === 0) {
    return [];
  }

  // 问题向量化
  const questionVector = await getEmbedding(question);

  // 过滤指定教材
  let candidates = vectorCache;
  if (materialIds && materialIds.length > 0) {
    candidates = vectorCache.filter((e) => materialIds.includes(e.materialId));
  }

  // 计算相似度并排序
  const scored = candidates.map((entry) => ({
    chunkId: entry.chunkId,
    materialId: entry.materialId,
    similarity: cosineSimilarity(questionVector, entry.vector),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  const topResults = scored.slice(0, topK).filter((r) => r.similarity > 0.3);

  if (topResults.length === 0) return [];

  // 批量获取 chunk 详情
  const chunkIds = topResults.map((r) => r.chunkId);
  const chunkDetails = await db
    .select({
      id: materialChunks.id,
      materialId: materialChunks.materialId,
      content: materialChunks.content,
      chapter: materialChunks.chapter,
      pageStart: materialChunks.pageStart,
      pageEnd: materialChunks.pageEnd,
    })
    .from(materialChunks)
    .where(inArray(materialChunks.id, chunkIds));

  // 获取教材标题
  const matIds = Array.from(new Set(chunkDetails.map((c) => c.materialId)));
  const matDetails = await db
    .select({ id: materials.id, title: materials.title })
    .from(materials)
    .where(inArray(materials.id, matIds));

  const matMap = new Map(matDetails.map((m) => [m.id, m.title]));
  const chunkMap = new Map(chunkDetails.map((c) => [c.id, c]));

  return topResults
    .map((r) => {
      const chunk = chunkMap.get(r.chunkId);
      if (!chunk) return null;
      return {
        chunkId: r.chunkId,
        materialId: r.materialId,
        materialTitle: matMap.get(r.materialId) || "未知教材",
        chapter: chunk.chapter,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        content: chunk.content,
        similarity: r.similarity,
      };
    })
    .filter(Boolean) as SearchResult[];
}

// ─── 清除指定教材的向量缓存 ───────────────────────────────────────────────────
export function invalidateMaterialCache(materialId: number): void {
  vectorCache = vectorCache.filter((e) => e.materialId !== materialId);
}

// ─── 强制刷新缓存 ─────────────────────────────────────────────────────────────
export async function forceRefreshCache(): Promise<void> {
  cacheLastRefreshed = 0;
  await refreshVectorCache();
}
