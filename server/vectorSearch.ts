/**
 * 教材检索服务
 * 由于 Forge API 不支持 Embedding 端点，本实现改用 MySQL 全文关键词检索。
 * 检索策略：
 *   1. 对问题进行分词（提取关键词）
 *   2. 使用 MySQL LIKE 多关键词匹配，计算命中分数
 *   3. 返回 Top-K 最相关的教材片段
 * 对于 10 本教材（约 5000-10000 个 chunk），此方案完全满足性能需求。
 */
import { getDb } from "./db";
import { materialChunks, materials } from "../drizzle/schema";
import { eq, inArray, and, like, or, sql } from "drizzle-orm";

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

// ─── 中文分词（基于 n-gram 提取关键词）───────────────────────
function extractKeywords(text: string): string[] {
  // 移除标点符号和常见问句词
  const cleaned = text
    .replace(/[，。？！、；：“”‘’（）【】《》、？!?,;:"'()\[\]]/g, " ")
    .replace(/什么是|如何|怎么|怎样|为什么|哪些|请问|介绍|说明|解释|试述|分析|比较|请说明|请介绍/g, " ")
    .trim();
  
  const keywords: string[] = [];
  const stopWords = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '上面', '下面', '什么', '如何', '怎么', '怎样', '为什么', '哪些',
    '这个', '那个', '这些', '那些', '这样', '那样', '可以', '应该',
    '需要', '能够', '进行', '实现', '就是', '也就', '不是', '就会',
    '主要', '基本', '一般', '通常', '具有', '包括', '属于'
  ]);
  
  // 提取英文单词（3字母以上）
  const englishMatches = cleaned.match(/[a-zA-Z]{3,}/g) || [];
  keywords.push(...englishMatches.map(w => w.toLowerCase()));
  
  // 提取中文：先按空格分割成词组，再提取 n-gram
  const segments = cleaned.split(/\s+/).filter(s => s.length > 0);
  
  for (const seg of segments) {
    // 提取纯中文片段
    const chineseParts = seg.match(/[\u4e00-\u9fa5]+/g) || [];
    for (const part of chineseParts) {
      if (part.length >= 2 && part.length <= 8 && !stopWords.has(part)) {
        keywords.push(part);
      }
      // 提取 2-gram
      if (part.length >= 4) {
        for (let i = 0; i <= part.length - 2; i++) {
          const bigram = part.slice(i, i + 2);
          if (!stopWords.has(bigram)) keywords.push(bigram);
        }
      }
      // 提取 3-gram
      if (part.length >= 5) {
        for (let i = 0; i <= part.length - 3; i++) {
          const trigram = part.slice(i, i + 3);
          if (!stopWords.has(trigram)) keywords.push(trigram);
        }
      }
      // 提取 4-gram
      if (part.length >= 6) {
        for (let i = 0; i <= part.length - 4; i++) {
          const fourgram = part.slice(i, i + 4);
          if (!stopWords.has(fourgram)) keywords.push(fourgram);
        }
      }
    }
  }
  
  return Array.from(new Set(keywords)).filter(k => !stopWords.has(k) && k.length >= 2);
}

// ─── 计算文本与关键词的匹配分数 ───────────────────────────────────────────────
function scoreChunk(content: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lowerContent = content.toLowerCase();
  let score = 0;
  let matchedKeywords = 0;
  
  for (const kw of keywords) {
    const lowerKw = kw.toLowerCase();
    // 计算关键词出现次数
    let pos = 0;
    let count = 0;
    while ((pos = lowerContent.indexOf(lowerKw, pos)) !== -1) {
      count++;
      pos += lowerKw.length;
    }
    if (count > 0) {
      matchedKeywords++;
      // TF 分数：出现次数 / 内容长度，并乘以关键词长度权重（长词更重要）
      score += (count / (content.length / 100)) * Math.log(kw.length + 1);
    }
  }
  
  // 覆盖率加权：匹配到的关键词比例
  const coverageBonus = matchedKeywords / keywords.length;
  return score * (0.5 + 0.5 * coverageBonus);
}

// ─── 关键词检索 Top-K ─────────────────────────────────────────────────────────
export async function semanticSearch(
  question: string,
  topK: number = 8,
  materialIds?: number[]
): Promise<SearchResult[]> {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");

  const keywords = extractKeywords(question);
  if (keywords.length === 0) return [];

  // 从数据库获取所有已发布教材的 chunks
  // 为避免全表扫描，先用 LIKE 过滤出包含至少一个关键词的 chunks
  const topKeywords = keywords.slice(0, 5); // 最多用5个关键词做 SQL 过滤
  
  const likeConditions = topKeywords.map(kw => 
    like(materialChunks.content, `%${kw}%`)
  );
  
  let query = db
    .select({
      id: materialChunks.id,
      materialId: materialChunks.materialId,
      content: materialChunks.content,
      chapter: materialChunks.chapter,
      pageStart: materialChunks.pageStart,
      pageEnd: materialChunks.pageEnd,
    })
    .from(materialChunks)
    .innerJoin(materials, eq(materialChunks.materialId, materials.id))
    .where(
      and(
        eq(materials.status, 'published'),
        materialIds && materialIds.length > 0
          ? inArray(materialChunks.materialId, materialIds)
          : undefined,
        or(...likeConditions)
      )
    )
    .limit(200); // 候选集最多200个，再在应用层精排

  const candidates = await query;
  
  if (candidates.length === 0) return [];

  // 应用层精排：计算每个 chunk 的关键词匹配分数
  const scored = candidates.map(chunk => ({
    ...chunk,
    score: scoreChunk(chunk.content, keywords),
  }));

  // 按分数降序排列，取 Top-K
  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, topK).filter(r => r.score > 0);

  if (topResults.length === 0) return [];

  // 获取教材标题
  const matIds = Array.from(new Set(topResults.map(c => c.materialId)));
  const matDetails = await db
    .select({ id: materials.id, title: materials.title })
    .from(materials)
    .where(inArray(materials.id, matIds));

  const matMap = new Map(matDetails.map(m => [m.id, m.title]));

  return topResults.map(r => ({
    chunkId: r.id,
    materialId: r.materialId,
    materialTitle: matMap.get(r.materialId) || "未知教材",
    chapter: r.chapter,
    pageStart: r.pageStart,
    pageEnd: r.pageEnd,
    content: r.content,
    similarity: Math.min(r.score / 10, 1), // 归一化到 0-1
  }));
}

// ─── 存储向量（兼容接口，全文检索模式下不需要存储向量）────────────────────────
export async function storeChunkVector(
  chunkId: number,
  _vector: number[]
): Promise<void> {
  // 全文检索模式下，标记 vectorId 为 "fulltext" 表示已处理
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");
  await db
    .update(materialChunks)
    .set({ vectorId: "fulltext" })
    .where(eq(materialChunks.id, chunkId));
}

// ─── 清除缓存（全文检索模式下无需缓存）──────────────────────────────────────
export function invalidateMaterialCache(_materialId: number): void {
  // no-op in fulltext mode
}

export async function forceRefreshCache(): Promise<void> {
  // no-op in fulltext mode
}
