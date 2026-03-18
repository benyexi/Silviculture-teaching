/**
 * 教材检索服务
 * 由于 Forge API 不支持 Embedding 端点，本实现改用 MySQL 全文关键词检索。
 * 检索策略：
 *   1. 对问题进行分词（提取关键词）
 *   2. 多策略检索：精确短语 + 关键词 OR 匹配
 *   3. 使用 TF-IDF 启发式评分，长关键词权重更高
 *   4. 返回 Top-K 最相关的教材片段
 * 对于 10 本教材（约 5000-10000 个 chunk），此方案完全满足性能需求。
 */
import { getDb } from "./db";
import { materialChunks, materials } from "../drizzle/schema";
import { eq, inArray, and, like, or } from "drizzle-orm";
import { detectLanguage } from "./languageDetect";

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

// ─── 林业领域同义词扩展表 ───────────────────────────────────────────────────
const SYNONYM_MAP: Record<string, string[]> = {
  '造林密度': ['林分密度', '初植密度', '种植密度', '密度'],
  '林分密度': ['造林密度', '初植密度', '种植密度', '密度'],
  '造林': ['人工林', '植树', '营造林', '造林更新'],
  '立地质量': ['立地条件', '立地指数', '地位指数', '立地'],
  '树种选择': ['适地适树', '树种配置', '造林树种'],
  '苗木质量': ['苗木规格', '苗木标准', '苗木等级'],
  '抚育间伐': ['间伐', '疏伐', '抚育采伐', '透光伐'],
  '森林更新': ['天然更新', '人工更新', '更新造林'],
  '整地': ['土地整理', '造林整地', '整地方式'],
  '施肥': ['林木施肥', '追肥', '基肥', '肥料'],

  // 采伐与更新
  '主伐': ['采伐', '皆伐', '择伐', '渐伐', '轮伐'],
  '采伐': ['主伐', '皆伐', '择伐', '渐伐', '更新采伐'],
  '天然更新': ['天然林更新', '自然更新', '萌芽更新', '根蘖更新'],
  '人工更新': ['造林更新', '人工造林', '补植'],

  // 林分结构
  '郁闭度': ['林冠覆盖', '冠层郁闭', '林冠郁闭度'],
  '树高': ['林木高度', '树木高度', '立木高度', '优势木高'],
  '胸径': ['胸高直径', 'DBH', '直径', '林木直径'],
  '蓄积量': ['林分蓄积', '木材蓄积', '立木蓄积'],

  // 立地与土壤
  '立地指数': ['地位指数', '立地质量指数', '立地等级'],
  '土壤肥力': ['土壤养分', '土壤肥沃度', '土壤质量'],
  '坡向': ['坡面方向', '阴坡', '阳坡', '半阴坡'],

  // 苗木培育
  '容器苗': ['营养袋苗', '穴盘苗', '容器育苗'],
  '裸根苗': ['裸根育苗', '大田苗', '普通苗'],
  '扦插': ['插条', '扦插繁殖', '营养繁殖'],

  // 抚育管理
  '透光伐': ['透光抚育', '幼林透光', '疏伐'],
  '生长伐': ['生长抚育', '间伐', '疏伐'],
  '卫生伐': ['卫生采伐', '清理采伐'],
  '修枝': ['整枝', '剪枝', '林木修枝'],

  // 混交林
  '混交林': ['混交造林', '针阔混交', '乔灌混交', '混交方式', '混交类型'],
  '混交方式': ['混交类型', '混交林', '株间混交', '行间混交', '带状混交', '块状混交', '星状混交', '植生组混交', '混交方法'],
  '混交类型': ['混交方式', '混交方法', '混交林类型'],
  '纯林': ['单一树种林', '单树种造林'],

  // 种子与繁殖
  '种子园': ['母树林', '种子基地', '良种基地'],
  '播种': ['直播造林', '播种造林', '撒播'],

  // 保护与病虫害
  '病虫害': ['森林病害', '森林虫害', '林木病虫', '病害防治'],
  '防护林': ['防风林', '水土保持林', '水源涵养林'],

  // 水分管理
  '灌溉': ['灌水', '浇水', '合理灌溉', '灌溉方法', '水分管理'],
  '合理灌溉': ['灌溉', '灌水', '浇水', '水分管理', '灌溉制度'],
  '排水': ['排涝', '排水沟', '排水系统'],

  // 土壤管理
  '除草': ['草害', '杂草防治', '化学除草', '除草剂'],
  '松土': ['中耕', '松土除草', '土壤管理'],

  // 造林方法
  '植苗造林': ['栽植', '植苗', '苗木栽植'],
  '直播造林': ['播种造林', '直播', '飞播造林'],
  '分殖造林': ['营养繁殖造林', '插条造林'],
};

function expandWithSynonyms(keywords: string[]): string[] {
  const expanded = new Set(keywords);
  for (const kw of keywords) {
    if (SYNONYM_MAP[kw]) {
      SYNONYM_MAP[kw].forEach(syn => expanded.add(syn));
    }
    // 反向查找
    for (const [key, syns] of Object.entries(SYNONYM_MAP)) {
      if (syns.includes(kw)) {
        expanded.add(key);
        syns.forEach(s => expanded.add(s));
      }
    }
  }
  return Array.from(expanded);
}

// ─── 中文分词（基于 n-gram 提取关键词）───────────────────────
export function extractKeywords(text: string): string[] {
  // 移除标点符号和常见问句词
  const cleaned = text
    .replace(/[，。？！、；：""''（）【】《》、？!?,;:"'()\[\]]/g, " ")
    .replace(/什么是|如何|怎么|怎样|为什么|哪些|请问|介绍|说明|解释|试述|分析|比较|请说明|请介绍|阐述|论述/g, " ")
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

const EN_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "this", "that",
  "these", "those", "it", "its", "what", "which", "who", "how", "when",
  "where", "why", "not", "no", "nor", "so", "yet", "both", "either",
]);

export function extractKeywordsEn(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !EN_STOP_WORDS.has(w));

  const keywords = [...new Set(words)];

  const wordArr = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !EN_STOP_WORDS.has(w));

  for (let i = 0; i < wordArr.length - 1; i++) {
    const bigram = `${wordArr[i]} ${wordArr[i + 1]}`;
    if (!EN_STOP_WORDS.has(wordArr[i]) && !EN_STOP_WORDS.has(wordArr[i + 1])) {
      keywords.push(bigram);
    }
  }

  return [...new Set(keywords)].slice(0, 15);
}

// ─── 通用高频词（2字），在评分时大幅降权 ──────────────────────────────────────
const GENERIC_2CHAR_WORDS = new Set([
  '合理', '基本', '主要', '一般', '常见', '重要', '特殊', '正常',
  '适当', '有效', '相关', '具体', '实际', '作用', '方法', '原则',
  '条件', '因素', '类型', '特点', '标准', '要求', '技术', '管理',
  '质量', '数量', '关系', '过程', '阶段', '时期', '措施', '问题',
]);

// ─── 计算文本与关键词的匹配分数（改进版 TF-IDF 启发式）──────────────────────
function scoreChunk(content: string, keywords: string[], originalQuestion: string, chapter?: string): number {
  if (keywords.length === 0) return 0;
  const lowerContent = content.toLowerCase();
  let score = 0;

  // 从原始问题中提取核心专业词（非通用词，长度>=2）
  const coreKeywords = keywords.filter(k => k.length >= 3 || (k.length === 2 && !GENERIC_2CHAR_WORDS.has(k)));

  for (const kw of keywords) {
    const lowerKw = kw.toLowerCase();
    let pos = 0;
    let count = 0;
    while ((pos = lowerContent.indexOf(lowerKw, pos)) !== -1) {
      count++;
      pos += lowerKw.length;
    }
    if (count > 0) {
      // 通用2字词大幅降权
      const isGeneric = kw.length === 2 && GENERIC_2CHAR_WORDS.has(kw);
      const genericPenalty = isGeneric ? 0.1 : 1.0;

      // 长关键词权重更高（指数级），短词权重较低
      const lengthWeight = Math.pow(kw.length, 1.5);
      // TF 分数：出现次数 / 内容长度
      const tf = count / (content.length / 100);
      score += tf * lengthWeight * genericPenalty;
    }
  }

  // 核心关键词覆盖率加权（排除通用词后的覆盖率）
  const coreCoverage = coreKeywords.length > 0
    ? coreKeywords.filter(k => lowerContent.includes(k.toLowerCase())).length / coreKeywords.length
    : 0;

  // 原始问题完整短语匹配：最高优先级
  // 如果原始问题的完整文本（去掉问号等标点）出现在 chunk 中，大幅加分
  const cleanedQuestion = originalQuestion.replace(/[？?！!。，,、\s]+/g, '');
  if (cleanedQuestion.length >= 3 && lowerContent.includes(cleanedQuestion.toLowerCase())) {
    score += cleanedQuestion.length * 10;
  }

  // 如果原始问题中的关键词（3字以上）直接出现在内容中，大幅加分
  const longPhrases = keywords.filter(k => k.length >= 3);
  let phraseBonus = 0;
  for (const phrase of longPhrases) {
    if (lowerContent.includes(phrase.toLowerCase())) {
      phraseBonus += phrase.length * 3;
    }
  }

  // 章节标题匹配加分
  if (chapter) {
    for (const kw of coreKeywords) {
      if (chapter.includes(kw)) {
        score += kw.length * 5;
      }
    }
  }

  return (score * (0.3 + 0.7 * coreCoverage)) + phraseBonus;
}

// ─── 混合检索 Top-K（关键词 + 向量语义） ──────────────────────────────────────
export async function semanticSearch(
  question: string,
  materialIds?: number[],
  topK: number = 8,
  languageFilter: "zh" | "en" | "all" = "all",
  useEmbedding: boolean = true
): Promise<SearchResult[]> {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");

  const questionLang = detectLanguage(question);
  const rawKeywords =
    questionLang === "en" ? extractKeywordsEn(question) : extractKeywords(question);

  // 同义词扩展：增加检索召回率
  const keywords = questionLang === "en" ? rawKeywords : expandWithSynonyms(rawKeywords);

  // 将原始问题的完整核心短语加入关键词（去掉问号等标点和常见提问词）
  const cleanedQ = question
    .replace(/[，。？！、；：""''（）【】《》？!?,;:"'()\[\]\s]+/g, "")
    .replace(/什么是|如何|怎么|怎样|为什么|哪些|请问|介绍|说明|解释|试述|分析|比较|请说明|请介绍|阐述|论述/g, "");
  if (cleanedQ.length >= 2 && cleanedQ.length <= 10 && !keywords.includes(cleanedQ)) {
    keywords.unshift(cleanedQ); // 放在最前面，最高优先级
  }

  // ─── 路径1：关键词检索 ─────────────────────────────────────────────────────
  let keywordCandidates: typeof vectorCandidates = [];
  if (keywords.length > 0) {
    const sortedKeywords = [...keywords].sort((a, b) => b.length - a.length);
    const sqlKeywords = sortedKeywords.slice(0, 10);

    const likeConditions = sqlKeywords.map(kw =>
      like(materialChunks.content, `%${kw}%`)
    );

    const kwWhere = and(
      eq(materials.status, 'published'),
      languageFilter !== "all" ? eq(materials.language, languageFilter) : undefined,
      materialIds && materialIds.length > 0
        ? inArray(materialChunks.materialId, materialIds)
        : undefined,
      or(...likeConditions)
    );

    keywordCandidates = await db
      .select({
        id: materialChunks.id,
        materialId: materialChunks.materialId,
        content: materialChunks.content,
        chapter: materialChunks.chapter,
        pageStart: materialChunks.pageStart,
        pageEnd: materialChunks.pageEnd,
        embedding: materialChunks.embedding,
      })
      .from(materialChunks)
      .innerJoin(materials, eq(materialChunks.materialId, materials.id))
      .where(kwWhere)
      .limit(300);
  }

  // ─── 路径2：向量语义检索（仅在 useEmbedding=true 时启用） ─────────────────
  let questionEmbedding: number[] | null = null;
  let vectorCandidates: {
    id: number;
    materialId: number;
    content: string;
    chapter: string | null;
    pageStart: number | null;
    pageEnd: number | null;
    embedding: number[] | null;
  }[] = [];

  if (useEmbedding) try {
    const { getEmbedding } = await import("./llmDriver");
    questionEmbedding = await getEmbedding(question);

    // 获取所有有 embedding 的 chunks（向量检索走全表扫描，对 <10000 chunks 完全可行）
    const vecWhere = and(
      eq(materials.status, 'published'),
      languageFilter !== "all" ? eq(materials.language, languageFilter) : undefined,
      materialIds && materialIds.length > 0
        ? inArray(materialChunks.materialId, materialIds)
        : undefined,
      eq(materialChunks.vectorId, "embedded")
    );

    vectorCandidates = await db
      .select({
        id: materialChunks.id,
        materialId: materialChunks.materialId,
        content: materialChunks.content,
        chapter: materialChunks.chapter,
        pageStart: materialChunks.pageStart,
        pageEnd: materialChunks.pageEnd,
        embedding: materialChunks.embedding,
      })
      .from(materialChunks)
      .innerJoin(materials, eq(materialChunks.materialId, materials.id))
      .where(vecWhere);
  } catch {
    // Embedding 未配置，仅用关键词检索
  }

  // ─── 合并评分 ──────────────────────────────────────────────────────────────
  // 用 Map 去重，以 chunk id 为 key
  const scoreMap = new Map<number, {
    id: number;
    materialId: number;
    content: string;
    chapter: string | null;
    pageStart: number | null;
    pageEnd: number | null;
    keywordScore: number;
    vectorScore: number;
    finalScore: number;
  }>();

  // 关键词评分
  for (const chunk of keywordCandidates) {
    const kwScore = scoreChunk(chunk.content, keywords, question, chunk.chapter ?? undefined);
    scoreMap.set(chunk.id, {
      id: chunk.id,
      materialId: chunk.materialId,
      content: chunk.content,
      chapter: chunk.chapter,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      keywordScore: kwScore,
      vectorScore: 0,
      finalScore: 0,
    });
  }

  // 向量评分
  if (questionEmbedding) {
    const { cosineSimilarity } = await import("./llmDriver");
    for (const chunk of vectorCandidates) {
      if (!chunk.embedding) continue;
      const vecScore = cosineSimilarity(questionEmbedding, chunk.embedding);

      const existing = scoreMap.get(chunk.id);
      if (existing) {
        existing.vectorScore = vecScore;
      } else {
        scoreMap.set(chunk.id, {
          id: chunk.id,
          materialId: chunk.materialId,
          content: chunk.content,
          chapter: chunk.chapter,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          keywordScore: 0,
          vectorScore: vecScore,
          finalScore: 0,
        });
      }
    }
  }

  if (scoreMap.size === 0) return [];

  // 计算混合分数：关键词和向量各自归一化后加权合并
  const entries = Array.from(scoreMap.values());
  const maxKwScore = Math.max(...entries.map(e => e.keywordScore), 1);
  const hasVector = entries.some(e => e.vectorScore > 0);

  for (const entry of entries) {
    const normKw = entry.keywordScore / maxKwScore; // 归一化到 0-1
    const normVec = entry.vectorScore; // 余弦相似度本身就是 0-1

    if (hasVector) {
      // 混合模式：关键词 40% + 向量 60%
      entry.finalScore = normKw * 0.4 + normVec * 0.6;
    } else {
      // 纯关键词模式
      entry.finalScore = normKw;
    }
  }

  // 排序取 Top-K
  entries.sort((a, b) => b.finalScore - a.finalScore);
  const topResults = entries.slice(0, topK).filter(r => r.finalScore > 0);

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
    similarity: r.finalScore,
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
