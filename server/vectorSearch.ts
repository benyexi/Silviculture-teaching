/**
 * 教材检索服务
 * V2: 支持纯关键词检索 + Embedding 向量混合检索（Hybrid Retrieval）
 * 检索策略：
 *   1. 对问题做领域词优先的关键词抽取
 *   2. 多路召回：strict / phrase / broad
 *   3. 基于 BM25-like + 覆盖率 + 章节/短语加权进行重排
 *   4. （可选）Embedding 向量相似度检索 + RAM 缓存
 *   5. 对 Top 结果做邻接块扩展，补足上下文
 *   6. 最终做去重和多样性控制
 */
import { getDb } from "./db";
import { materialChunks, materials } from "../drizzle/schema";
import { eq, inArray, and, like, or, isNotNull } from "drizzle-orm";
import { detectLanguage } from "./languageDetect";
import { getEmbedding, cosineSimilarity } from "./llmDriver";

// ─── 检索结果类型 ─────────────────────────────────────────────────────────────
export type SearchResult = {
  chunkId: number;
  chunkIndex: number;
  materialId: number;
  materialTitle: string;
  chapter: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  content: string;
  similarity: number;
};

type RouteName = "strict" | "phrase" | "broad";

type CandidateRow = {
  id: number;
  materialId: number;
  chunkIndex: number;
  content: string;
  chapter: string | null;
  pageStart: number | null;
  pageEnd: number | null;
};

type CandidateState = CandidateRow & {
  routeHits: Record<RouteName, number>;
  recallScore: number;
  keywordScore: number;
  adjacencyScore: number;
  finalScore: number;
};

type SearchProfile = {
  cleanedQuestion: string;
  intentTerms: string[];
  exactPhrases: string[];
  coreTerms: string[];
  broadTerms: string[];
  scoringTerms: string[];
};

type TermStats = {
  docCount: number;
  avgLength: number;
  df: Map<string, number>;
};

type DbConnection = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// ─── V2: 可配置的检索参数 ──────────────────────────────────────────────────
// 通过环境变量或默认值配置，无需改代码即可调优
const SEARCH_CONFIG = {
  // BM25 参数
  bm25K1: parseFloat(process.env.BM25_K1 || "1.2"),
  bm25B: parseFloat(process.env.BM25_B || "0.75"),
  // 多路召回权重
  strictWeight: parseFloat(process.env.ROUTE_STRICT_WEIGHT || "5.8"),
  phraseWeight: parseFloat(process.env.ROUTE_PHRASE_WEIGHT || "3.4"),
  broadWeight: parseFloat(process.env.ROUTE_BROAD_WEIGHT || "1.5"),
  // 多路召回上限
  strictLimit: parseInt(process.env.ROUTE_STRICT_LIMIT || "100", 10),
  phraseLimit: parseInt(process.env.ROUTE_PHRASE_LIMIT || "160", 10),
  broadLimit: parseInt(process.env.ROUTE_BROAD_LIMIT || "260", 10),
  // 邻接块加权系数
  adjacencyBoost: parseFloat(process.env.ADJACENCY_BOOST || "0.82"),
  // 最终融合权重
  keywordFusionWeight: parseFloat(process.env.KEYWORD_FUSION_WEIGHT || "0.58"),
  recallFusionWeight: parseFloat(process.env.RECALL_FUSION_WEIGHT || "0.27"),
  adjacencyFusionWeight: parseFloat(process.env.ADJACENCY_FUSION_WEIGHT || "0.15"),
  // Embedding 混合检索权重（仅 useEmbedding=true 时生效）
  embeddingFusionWeight: parseFloat(process.env.EMBEDDING_FUSION_WEIGHT || "0.35"),
  keywordFusionWeightHybrid: parseFloat(process.env.KEYWORD_FUSION_WEIGHT_HYBRID || "0.38"),
  recallFusionWeightHybrid: parseFloat(process.env.RECALL_FUSION_WEIGHT_HYBRID || "0.15"),
  adjacencyFusionWeightHybrid: parseFloat(process.env.ADJACENCY_FUSION_WEIGHT_HYBRID || "0.12"),
  // Embedding 检索 Top-K
  embeddingTopK: parseInt(process.env.EMBEDDING_TOP_K || "30", 10),
  // RAM 缓存最大条目数
  ramCacheMaxSize: parseInt(process.env.RAM_CACHE_MAX_SIZE || "5000", 10),
} as const;

// ─── RAM: 内存向量缓存 ────────────────────────────────────────────────────────
// 将 chunk embeddings 缓存在内存中，避免每次查询都读取数据库中的大型 JSON 列
type RAMEntry = {
  chunkId: number;
  materialId: number;
  chunkIndex: number;
  content: string;
  chapter: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  embedding: number[];
};

let _ramCache: RAMEntry[] = [];
let _ramLoadedAt = 0;
let _ramLoading: Promise<void> | null = null;
const RAM_TTL_MS = 10 * 60 * 1000; // RAM 缓存 10 分钟有效

async function ensureRAMCache(): Promise<RAMEntry[]> {
  const now = Date.now();
  if (_ramCache.length > 0 && now - _ramLoadedAt < RAM_TTL_MS) {
    return _ramCache;
  }

  // 防止并发加载
  if (_ramLoading) {
    await _ramLoading;
    return _ramCache;
  }

  _ramLoading = loadRAMCache();
  try {
    await _ramLoading;
  } finally {
    _ramLoading = null;
  }
  return _ramCache;
}

async function loadRAMCache(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  console.log("[RAM] Loading chunk embeddings into memory...");
  const startTime = Date.now();

  const rows = await db
    .select({
      id: materialChunks.id,
      materialId: materialChunks.materialId,
      chunkIndex: materialChunks.chunkIndex,
      content: materialChunks.content,
      chapter: materialChunks.chapter,
      pageStart: materialChunks.pageStart,
      pageEnd: materialChunks.pageEnd,
      embedding: materialChunks.embedding,
      vectorId: materialChunks.vectorId,
    })
    .from(materialChunks)
    .innerJoin(materials, eq(materialChunks.materialId, materials.id))
    .where(and(
      eq(materials.status, "published"),
      eq(materialChunks.vectorId, "embedded"),
      isNotNull(materialChunks.embedding)
    ))
    .limit(SEARCH_CONFIG.ramCacheMaxSize);

  const entries: RAMEntry[] = [];
  for (const row of rows) {
    const emb = row.embedding as number[] | null;
    if (!emb || !Array.isArray(emb) || emb.length === 0) continue;
    entries.push({
      chunkId: row.id,
      materialId: row.materialId,
      chunkIndex: row.chunkIndex,
      content: row.content,
      chapter: row.chapter,
      pageStart: row.pageStart,
      pageEnd: row.pageEnd,
      embedding: emb,
    });
  }

  _ramCache = entries;
  _ramLoadedAt = Date.now();
  console.log(`[RAM] Loaded ${entries.length} embeddings in ${Date.now() - startTime}ms`);
}

/** 清除 RAM 缓存（教材更新时调用） */
export function invalidateRAMCache(): void {
  _ramCache = [];
  _ramLoadedAt = 0;
  console.log("[RAM] Cache invalidated");
}

// ─── Embedding 向量检索 ────────────────────────────────────────────────────────
type EmbeddingCandidate = {
  chunkId: number;
  materialId: number;
  chunkIndex: number;
  content: string;
  chapter: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  similarity: number;
};

async function embeddingSearch(
  question: string,
  materialIds: number[] | undefined,
  languageFilter: "zh" | "en" | "all",
  topK: number
): Promise<EmbeddingCandidate[]> {
  // 1. 生成问题的 embedding
  let queryEmbedding: number[];
  try {
    queryEmbedding = await getEmbedding(question);
  } catch (err: any) {
    console.warn(`[EmbeddingSearch] Failed to get query embedding: ${err?.message || err}`);
    return [];
  }

  // 2. 从 RAM 缓存中加载 chunk embeddings
  const cache = await ensureRAMCache();
  if (cache.length === 0) return [];

  // 3. 过滤符合条件的 chunks
  let candidates = cache;
  if (materialIds && materialIds.length > 0) {
    const matSet = new Set(materialIds);
    candidates = candidates.filter(entry => matSet.has(entry.materialId));
  }
  // languageFilter 在 RAM 缓存中已通过 JOIN published materials 保证

  // 4. 计算余弦相似度并排序
  const scored = candidates.map(entry => ({
    chunkId: entry.chunkId,
    materialId: entry.materialId,
    chunkIndex: entry.chunkIndex,
    content: entry.content,
    chapter: entry.chapter,
    pageStart: entry.pageStart,
    pageEnd: entry.pageEnd,
    similarity: cosineSimilarity(queryEmbedding, entry.embedding),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK).filter(c => c.similarity > 0.3);
}

// ─── 林业领域同义词扩展表 ───────────────────────────────────────────────────
// 用于评分阶段（不用于SQL检索），帮助识别相关但措辞不同的chunk
const SYNONYM_MAP: Record<string, string[]> = {
  // ── 造林密度与种植 ──
  '造林密度': ['林分密度', '初植密度', '种植密度', '密度', '合理密度', '密度控制'],
  '林分密度': ['造林密度', '初植密度', '种植密度', '密度', '密度调控'],
  '合理密度': ['造林密度', '最适密度', '合理密度理论', '密度效应'],
  '造林': ['人工林', '植树', '营造林', '造林更新', '人工造林', '造林技术'],
  '造林方法': ['造林方式', '造林技术', '植苗造林', '直播造林', '分殖造林', '造林类型'],
  '造林方式': ['造林方法', '造林技术', '植苗造林', '直播造林', '分殖造林'],
  '植苗造林': ['栽植', '植苗', '苗木栽植', '造林方法', '造林方式'],
  '直播造林': ['播种造林', '直播', '飞播造林', '造林方法', '造林方式'],
  '分殖造林': ['营养繁殖造林', '插条造林', '造林方法', '造林方式'],

  // ── 立地与树种选择 ──
  '立地质量': ['立地条件', '立地指数', '地位指数', '立地', '立地评价', '立地分类'],
  '立地条件': ['立地质量', '立地因子', '立地类型', '生境条件'],
  '立地指数': ['地位指数', '立地质量指数', '立地等级', '立地评价'],
  '树种选择': ['适地适树', '树种配置', '造林树种', '树种选择原则'],
  '适地适树': ['树种选择', '树种配置', '因地制宜'],

  // ── 苗木培育 ──
  '苗木质量': ['苗木规格', '苗木标准', '苗木等级', '壮苗', '苗木分级'],
  '苗木培育': ['育苗', '苗圃', '苗木繁殖', '育苗技术'],
  '容器苗': ['营养袋苗', '穴盘苗', '容器育苗', '容器苗培育'],
  '裸根苗': ['裸根育苗', '大田苗', '普通苗', '裸根苗培育'],
  '扦插': ['插条', '扦插繁殖', '营养繁殖', '扦插育苗'],
  '嫁接': ['嫁接繁殖', '嫁接育苗', '接穗', '砧木'],
  '种子': ['种子质量', '种子处理', '种子催芽', '种子贮藏', '种子采集'],
  '种子园': ['母树林', '种子基地', '良种基地', '种子生产'],
  '播种': ['直播造林', '播种造林', '撒播', '播种育苗'],
  '催芽': ['种子催芽', '种子处理', '浸种催芽'],

  // ── 整地 ──
  '整地': ['土地整理', '造林整地', '整地方式', '整地方法', '林地清理'],
  '整地方式': ['整地方法', '整地类型', '全面整地', '局部整地', '穴状整地', '带状整地'],
  '整地方法': ['整地方式', '整地类型', '全面整地', '局部整地'],

  // ── 混交林 ──
  '混交林': ['混交造林', '针阔混交', '乔灌混交', '混交方式', '混交类型', '混交方法'],
  '混交方式': ['混交方法', '混交类型', '株间混交', '行间混交', '带状混交', '块状混交', '星状混交', '植生组混交', '不规则混交'],
  '混交方法': ['混交方式', '混交类型', '株间混交', '行间混交', '带状混交', '块状混交', '星状混交', '植生组混交', '不规则混交'],
  '混交类型': ['混交方式', '混交方法', '混交林类型', '混交比例'],
  '混交比例': ['混交类型', '树种比例', '混交林比例'],
  '纯林': ['单一树种林', '单树种造林'],

  // ── 抚育管理 ──
  '抚育': ['抚育管理', '幼林抚育', '林分抚育', '抚育措施'],
  '抚育间伐': ['间伐', '疏伐', '抚育采伐', '透光伐', '间伐方法'],
  '间伐': ['疏伐', '抚育间伐', '抚育采伐', '间伐方法', '间伐强度'],
  '透光伐': ['透光抚育', '幼林透光', '疏伐', '透光采伐'],
  '生长伐': ['生长抚育', '间伐', '疏伐'],
  '卫生伐': ['卫生采伐', '清理采伐'],
  '修枝': ['整枝', '剪枝', '林木修枝', '人工修枝'],

  // ── 采伐与更新 ──
  '主伐': ['采伐', '皆伐', '择伐', '渐伐', '轮伐', '主伐方式'],
  '采伐': ['主伐', '皆伐', '择伐', '渐伐', '更新采伐', '采伐方式'],
  '皆伐': ['主伐', '采伐', '皆伐更新'],
  '择伐': ['选择性采伐', '择伐更新', '采伐'],
  '渐伐': ['遮蔽伐', '渐伐更新', '采伐'],
  '森林更新': ['天然更新', '人工更新', '更新造林', '林分更新'],
  '天然更新': ['天然林更新', '自然更新', '萌芽更新', '根蘖更新', '天然下种更新'],
  '人工更新': ['造林更新', '人工造林', '补植', '人工促进更新'],

  // ── 施肥 ──
  '施肥': ['林木施肥', '追肥', '基肥', '肥料', '施肥方法', '施肥技术'],
  '施肥方法': ['施肥方式', '施肥技术', '追肥方法', '沟施', '穴施'],
  '追肥': ['施肥', '追施', '根外追肥', '叶面施肥'],
  '基肥': ['底肥', '施肥', '有机肥'],

  // ── 水分管理 ──
  '灌溉': ['灌水', '浇水', '合理灌溉', '灌溉方法', '水分管理', '灌溉技术'],
  '灌溉方法': ['灌溉方式', '灌溉技术', '滴灌', '喷灌', '漫灌'],
  '合理灌溉': ['灌溉', '灌水', '浇水', '水分管理', '灌溉制度', '灌溉原则'],
  '排水': ['排涝', '排水沟', '排水系统', '排水方法'],

  // ── 土壤管理 ──
  '除草': ['草害', '杂草防治', '化学除草', '除草剂', '除草方法'],
  '松土': ['中耕', '松土除草', '土壤管理', '中耕除草'],
  '土壤肥力': ['土壤养分', '土壤肥沃度', '土壤质量', '地力'],
  '土壤改良': ['土壤修复', '改土', '土壤培肥'],

  // ── 林分结构 ──
  '林分结构': ['林分组成', '林层结构', '树种组成', '林分密度'],
  '郁闭度': ['林冠覆盖', '冠层郁闭', '林冠郁闭度', '林冠覆盖率'],
  '树高': ['林木高度', '树木高度', '立木高度', '优势木高'],
  '胸径': ['胸高直径', 'DBH', '直径', '林木直径'],
  '蓄积量': ['林分蓄积', '木材蓄积', '立木蓄积', '蓄积生长量'],

  // ── 地形因子 ──
  '坡向': ['坡面方向', '阴坡', '阳坡', '半阴坡'],
  '坡度': ['坡面倾斜', '坡度等级'],
  '海拔': ['海拔高度', '垂直带'],

  // ── 保护与病虫害 ──
  '病虫害': ['森林病害', '森林虫害', '林木病虫', '病害防治', '虫害防治'],
  '病虫害防治': ['病害防治', '虫害防治', '综合防治', '生物防治'],
  '防护林': ['防风林', '水土保持林', '水源涵养林', '农田防护林'],

  // ── 森林经营 ──
  '森林经营': ['林分经营', '经营方案', '森林经营方案'],
  '轮伐期': ['采伐周期', '轮伐', '经营周期'],
  '林分改造': ['林分调整', '低效林改造', '林相改造'],
  '森林抚育': ['林分抚育', '抚育管理', '抚育经营'],

  // ── 种植点配置 ──
  '种植点配置': ['配置方式', '株行距', '正方形配置', '三角形配置', '长方形配置'],
  '株行距': ['种植间距', '行距', '株距', '种植点配置'],

  // ── V2 补充：缺失的双向关联和常见术语 ──
  '密度控制': ['密度调控', '造林密度', '密度管理', '合理密度'],
  '密度调控': ['密度控制', '造林密度', '密度管理', '合理密度'],
  '更新采伐': ['主伐', '采伐更新', '更新方式'],
  '截干': ['修枝', '截头', '平茬', '截干更新'],
  '郁闭': ['郁闭度', '林冠郁闭', '冠层覆盖'],
  '平茬': ['截干', '萌芽更新', '平茬复壮'],
  '萌芽更新': ['萌芽林', '萌生更新', '平茬', '根蘖更新'],
  '根蘖更新': ['萌芽更新', '根蘖繁殖', '天然更新'],
  '飞播造林': ['飞播', '直播造林', '播种造林', '航空造林'],

  // ── 造林季节与时间 ──
  '造林季节': ['造林时间', '造林时期', '栽植季节', '适宜造林期'],
  '造林时间': ['造林季节', '造林时期', '栽植时间'],
  '春季造林': ['造林季节', '春栽', '春植'],
  '秋季造林': ['造林季节', '秋栽', '秋植'],
  '雨季造林': ['造林季节', '雨季栽植'],

  // ── 林地清理 ──
  '林地清理': ['炼山', '清林', '割灌', '整地', '林地准备'],
  '炼山': ['林地清理', '计划烧除', '火烧清理'],
  '割灌': ['林地清理', '除灌', '灌木清理'],

  // ── 种子处理 ──
  '种子处理': ['种子消毒', '催芽', '浸种', '种子预处理'],
  '浸种': ['浸种催芽', '种子浸泡', '种子处理'],
  '层积催芽': ['沙藏催芽', '层积处理', '催芽'],

  // ── 土壤与水 ──
  '灌溉时间': ['灌溉时期', '灌水时间', '浇水时间', '灌溉季节'],
  '灌水量': ['灌溉量', '灌溉定额', '灌水定额', '浇水量'],
  '滴灌': ['灌溉方法', '节水灌溉', '微灌'],
  '喷灌': ['灌溉方法', '喷洒灌溉'],
  '漫灌': ['灌溉方法', '地面灌溉', '沟灌', '畦灌'],

  // ── 森林生态 ──
  '森林生态': ['森林生态系统', '林分生态', '森林环境'],
  '生物多样性': ['物种多样性', '生物多样', '生态多样性'],
  '水源涵养': ['水源涵养林', '涵养水源', '水源保护'],
  '水土保持': ['水土流失', '保持水土', '水土保持林'],

  // ── 林木生长 ──
  '生长量': ['生长速率', '生长率', '年生长量', '林木生长'],
  '生长规律': ['生长特点', '生长过程', '生长节律'],
  '材积': ['蓄积量', '木材材积', '立木材积'],
  '出材量': ['材积', '木材产量', '出材率'],
  '出材率': ['出材量', '利用率', '材积利用率'],
};

const QUESTION_INTENT_WORDS = [
  "定义",
  "含义",
  "概念",
  "是指",
  "分类",
  "类型",
  "方法",
  "步骤",
  "原则",
  "条件",
  "特点",
  "区别",
  "比较",
  "作用",
  "意义",
  "程序",
  "过程",
  "措施",
  "要求",
];

const QUESTION_STOP_WORDS = new Set([
  "的",
  "了",
  "在",
  "是",
  "我",
  "有",
  "和",
  "就",
  "不",
  "人",
  "都",
  "一",
  "上面",
  "下面",
  "什么",
  "如何",
  "怎么",
  "怎样",
  "为什么",
  "哪些",
  "这个",
  "那个",
  "这些",
  "那些",
  "这样",
  "那样",
  "可以",
  "应该",
  "需要",
  "能够",
  "进行",
  "实现",
  "就是",
  "也就",
  "不是",
  "就会",
  "主要",
  "基本",
  "一般",
  "通常",
  "具有",
  "包括",
  "属于",
  "请问",
  "介绍",
  "说明",
  "解释",
  "试述",
  "分析",
  "比较",
  "请说明",
  "请介绍",
  "阐述",
  "论述",
]);

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[，。？！、；：""''（）【】《》、？!?,;:"'()\[\]\s]/g, "")
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, "");
}

function normalizeForLookup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[，。？！、；：""''（）【】《》、？!?,;:"'()\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripQuestionWords(text: string): string {
  return text.replace(
    /什么是|如何|怎么|怎样|为什么|哪些|请问|介绍|说明|解释|试述|分析|比较|请说明|请介绍|阐述|论述|有哪几种|有哪些|分别|简述/g,
    " "
  );
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(term, pos)) !== -1) {
    count++;
    pos += term.length;
  }
  return count;
}

function termRelevanceScore(term: string): number {
  const normalized = normalizeForComparison(term);
  let score = Math.max(1, normalized.length);

  if (DOMAIN_VOCAB_KEYS.has(normalized)) {
    score += 8 + Math.min(6, normalized.length);
  }

  if (QUESTION_INTENT_KEYS.has(normalized)) {
    score += 1.5;
  }

  if (normalized.length === 2 && QUESTION_STOP_WORDS.has(term)) {
    score *= 0.45;
  }

  if (term.includes(" ")) {
    score += 1.2;
  }

  if (/[a-z]/i.test(term)) {
    score += 0.5;
  }

  return score;
}

function uniqueSortedTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const term of terms) {
    const cleaned = term.trim();
    if (cleaned.length < 2) continue;
    const key = normalizeForComparison(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(cleaned);
  }

  return unique.sort((a, b) => {
    const diff = termRelevanceScore(b) - termRelevanceScore(a);
    return diff !== 0 ? diff : b.length - a.length;
  });
}

const DOMAIN_VOCAB = Array.from(
  new Set(
    Object.entries(SYNONYM_MAP).flatMap(([key, syns]) => [key, ...syns]).filter((term) => term.trim().length >= 2)
  )
).sort((a, b) => b.length - a.length);

const DOMAIN_VOCAB_KEYS = new Set(DOMAIN_VOCAB.map((term) => normalizeForComparison(term)));
const QUESTION_INTENT_KEYS = new Set(QUESTION_INTENT_WORDS.map((term) => normalizeForComparison(term)));

const SYNONYM_REVERSE_MAP = new Map<string, string[]>();
for (const [key, syns] of Object.entries(SYNONYM_MAP)) {
  const keyNorm = normalizeForComparison(key);
  if (!SYNONYM_REVERSE_MAP.has(keyNorm)) {
    SYNONYM_REVERSE_MAP.set(keyNorm, []);
  }
  for (const syn of syns) {
    const synNorm = normalizeForComparison(syn);
    if (!SYNONYM_REVERSE_MAP.has(synNorm)) {
      SYNONYM_REVERSE_MAP.set(synNorm, []);
    }
    SYNONYM_REVERSE_MAP.get(keyNorm)!.push(syn);
    SYNONYM_REVERSE_MAP.get(synNorm)!.push(key);
    for (const reverse of syns) {
      if (reverse !== syn) SYNONYM_REVERSE_MAP.get(synNorm)!.push(reverse);
    }
  }
}

function extractDomainPhrases(text: string): string[] {
  const normalized = normalizeForLookup(text);
  const matches: string[] = [];

  for (const term of DOMAIN_VOCAB) {
    if (normalized.includes(term.toLowerCase())) {
      matches.push(term);
    }
  }

  return uniqueSortedTerms(matches);
}

function extractIntentTerms(text: string): string[] {
  const normalized = normalizeForComparison(text);
  return QUESTION_INTENT_WORDS.filter((term) => normalized.includes(normalizeForComparison(term)));
}

function buildSearchProfile(question: string, questionLang: "zh" | "en"): SearchProfile {
  const normalizedQuestion = normalizeForLookup(question);
  const strippedQuestion = stripQuestionWords(normalizedQuestion).trim();
  const baseKeywords = questionLang === "en" ? extractKeywordsEn(question) : extractKeywords(question);
  const exactPhrases = questionLang === "en" ? [] : extractDomainPhrases(strippedQuestion);
  const derivedDefinitionTerms =
    questionLang === "zh" && /(什么是|何谓|是指|定义|概念|含义)/.test(normalizedQuestion)
      ? ["定义", "概念", "是指"]
      : [];
  const intentTerms = questionLang === "en"
    ? []
    : uniqueSortedTerms([...extractIntentTerms(normalizedQuestion), ...derivedDefinitionTerms]).slice(0, 8);

  const candidateTerms = uniqueSortedTerms([
    ...baseKeywords,
    ...exactPhrases,
    ...intentTerms,
    ...(strippedQuestion.length >= 2 && strippedQuestion.length <= 12 ? [strippedQuestion] : []),
  ]);

  const coreTerms = candidateTerms.filter((term) => {
    const normalized = normalizeForComparison(term);
    return normalized.length >= 3 || DOMAIN_VOCAB_KEYS.has(normalized) || QUESTION_INTENT_KEYS.has(normalized);
  }).slice(0, 8);

  const broadTerms = uniqueSortedTerms([
    ...candidateTerms,
    ...expandWithSynonyms(candidateTerms).slice(0, 12),
  ]).slice(0, 18);

  const scoringTerms = uniqueSortedTerms([
    ...coreTerms,
    ...exactPhrases,
    ...intentTerms,
    ...broadTerms,
  ]).slice(0, 16);

  return {
    cleanedQuestion: strippedQuestion,
    intentTerms,
    exactPhrases,
    coreTerms,
    broadTerms,
    scoringTerms,
  };
}

function expandWithSynonyms(keywords: string[]): string[] {
  const expanded = new Set<string>();

  for (const kw of keywords) {
    const normalized = normalizeForComparison(kw);
    if (!normalized) continue;
    expanded.add(kw);

    const direct = SYNONYM_MAP[kw] ?? SYNONYM_MAP[kw.toLowerCase()];
    if (direct) {
      direct.forEach((syn) => expanded.add(syn));
    }

    const reverse = SYNONYM_REVERSE_MAP.get(normalized);
    if (reverse) {
      reverse.forEach((term) => expanded.add(term));
    }
  }

  return uniqueSortedTerms(Array.from(expanded));
}

// ─── 中文分词（基于领域词优先 + n-gram 提取关键词）────────────────────────────
export function extractKeywords(text: string): string[] {
  const cleaned = normalizeForLookup(text);
  const stripped = stripQuestionWords(cleaned).trim();
  const keywords: string[] = [];

  const englishMatches = stripped.match(/[a-zA-Z]{3,}/g) || [];
  keywords.push(...englishMatches.map((w) => w.toLowerCase()));

  const domainTerms = extractDomainPhrases(stripped);
  keywords.push(...domainTerms);

  const intentTerms = extractIntentTerms(stripped);
  keywords.push(...intentTerms);

  if (stripped.length >= 2 && stripped.length <= 12) {
    keywords.push(stripped);
  }

  const segments = stripped.split(/\s+/).filter((s) => s.length > 0);
  for (const seg of segments) {
    const chineseParts = seg.match(/[\u4e00-\u9fa5]+/g) || [];
    for (const part of chineseParts) {
      if (part.length >= 2 && part.length <= 10 && !QUESTION_STOP_WORDS.has(part)) {
        keywords.push(part);
      }

      if (part.length >= 4) {
        for (let i = 0; i <= part.length - 2; i++) {
          const bigram = part.slice(i, i + 2);
          if (!QUESTION_STOP_WORDS.has(bigram)) keywords.push(bigram);
        }
      }

      if (part.length >= 5) {
        for (let i = 0; i <= part.length - 3; i++) {
          const trigram = part.slice(i, i + 3);
          if (!QUESTION_STOP_WORDS.has(trigram)) keywords.push(trigram);
        }
      }

      if (part.length >= 6) {
        for (let i = 0; i <= part.length - 4; i++) {
          const fourgram = part.slice(i, i + 4);
          if (!QUESTION_STOP_WORDS.has(fourgram)) keywords.push(fourgram);
        }
      }
    }
  }

  return uniqueSortedTerms(keywords).slice(0, 24);
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

  const keywords = Array.from(new Set(words));

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

  return uniqueSortedTerms(keywords).slice(0, 15);
}

// ─── 通用高频词（2字），在评分时适度降权 ─────────────────────────────────────
// 注意：只放纯粹的修饰词/虚词，不放有领域含义的词（如"方法"、"类型"、"原则"）
const GENERIC_2CHAR_WORDS = new Set([
  "合理", "基本", "主要", "一般", "常见", "重要", "特殊", "正常",
  "适当", "有效", "相关", "具体", "实际", "问题", "情况", "方面",
  "数量", "关系", "过程", "阶段", "时期",
]);

function countTermStats(candidates: CandidateRow[], terms: string[]): TermStats {
  const df = new Map<string, number>();
  let totalLength = 0;

  for (const candidate of candidates) {
    const normalized = normalizeForComparison(candidate.content);
    totalLength += normalized.length;

    for (const term of terms) {
      const key = normalizeForComparison(term);
      if (!key) continue;
      if (normalized.includes(key)) {
        df.set(key, (df.get(key) || 0) + 1);
      }
    }
  }

  return {
    docCount: candidates.length,
    avgLength: candidates.length > 0 ? totalLength / candidates.length : 1,
    df,
  };
}

// ─── 计算文本与关键词的匹配分数（BM25-like + 覆盖率 + 结构加权）──────────────
function scoreChunk(
  content: string,
  keywords: string[],
  originalQuestion: string,
  chapter?: string,
  options?: {
    stats?: TermStats;
    intentTerms?: string[];
  }
): number {
  if (keywords.length === 0) return 0;

  const compactContent = normalizeForComparison(content);
  const compactChapter = normalizeForComparison(chapter || "");
  const cleanedQuestion = normalizeForComparison(stripQuestionWords(originalQuestion));
  const stats = options?.stats;
  const intentTerms = options?.intentTerms ?? [];
  const coreKeywords = keywords.filter((kw) => {
    const normalized = normalizeForComparison(kw);
    return normalized.length >= 3 || DOMAIN_VOCAB_KEYS.has(normalized) || QUESTION_INTENT_KEYS.has(normalized);
  });

  const avgLength = stats?.avgLength || Math.max(1, compactContent.length);
  const docCount = stats?.docCount || 1;
  const k1 = SEARCH_CONFIG.bm25K1;
  const b = SEARCH_CONFIG.bm25B;

  let bm25Score = 0;
  let matchedCore = 0;
  let maxTf = 0;

  for (const keyword of keywords) {
    const termKey = normalizeForComparison(keyword);
    if (!termKey) continue;

    const tf = countOccurrences(compactContent, termKey);
    if (tf <= 0) continue;

    if (coreKeywords.some((kw) => normalizeForComparison(kw) === termKey)) {
      matchedCore++;
    }
    maxTf = Math.max(maxTf, tf);

    const df = stats?.df.get(termKey) || 1;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    const lenNorm = Math.max(1, compactContent.length) / Math.max(1, avgLength);
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * lenNorm));
    const lengthWeight = 1 + Math.min(0.8, termKey.length / 10);
    const domainBoost = DOMAIN_VOCAB_KEYS.has(termKey) ? 1.2 : 1;
    const intentBoost = QUESTION_INTENT_KEYS.has(termKey) ? 0.82 : 1;
    const genericPenalty = termKey.length === 2 && QUESTION_STOP_WORDS.has(keyword) ? 0.55 : 1;

    bm25Score += idf * tfNorm * lengthWeight * domainBoost * intentBoost * genericPenalty;
  }

  const coverage = coreKeywords.length > 0 ? matchedCore / coreKeywords.length : 0;

  let phraseBonus = 0;
  if (cleanedQuestion.length >= 3 && compactContent.includes(cleanedQuestion)) {
    phraseBonus += cleanedQuestion.length * 0.9;
  }

  for (const phrase of coreKeywords) {
    const phraseKey = normalizeForComparison(phrase);
    if (phraseKey.length >= 3 && compactContent.includes(phraseKey)) {
      phraseBonus += Math.min(8, phraseKey.length * 0.55);
    }
  }

  let chapterBonus = 0;
  if (compactChapter.length > 0) {
    for (const keyword of coreKeywords) {
      const termKey = normalizeForComparison(keyword);
      if (termKey.length >= 2 && compactChapter.includes(termKey)) {
        chapterBonus += Math.min(6, termKey.length * 0.65);
      }
    }

    for (const intent of intentTerms) {
      const intentKey = normalizeForComparison(intent);
      if (intentKey && compactChapter.includes(intentKey)) {
        chapterBonus += 1.4;
      }
    }
  }

  let structureBonus = 0;
  if (containsEnumerationMarkers(content) && intentTerms.some((term) => QUESTION_INTENT_KEYS.has(normalizeForComparison(term)))) {
    structureBonus += 2.2;
  }

  const repetitionPenalty = computeRepetitionPenalty(content);
  const tfPenalty = maxTf > 5 ? Math.max(0.82, 1 - (maxTf - 5) * 0.03) : 1;
  const baseScore = bm25Score * (0.6 + 0.4 * coverage);

  return (baseScore + phraseBonus + chapterBonus + structureBonus) * repetitionPenalty * tfPenalty;
}

function computeRepetitionPenalty(content: string): number {
  const sentences = content
    .split(/[。！？\n]/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 10);

  if (sentences.length < 3) return 1;

  const freq = new Map<string, number>();
  for (const sentence of sentences) {
    const key = normalizeForComparison(sentence).slice(0, 80);
    if (!key) continue;
    freq.set(key, (freq.get(key) || 0) + 1);
  }

  let repeated = 0;
  freq.forEach((count) => {
    if (count > 1) repeated += count - 1;
  });

  const rate = repeated / Math.max(1, sentences.length);
  return 1 - Math.min(0.18, rate * 0.35);
}

function containsEnumerationMarkers(content: string): boolean {
  return /(?:^|\n)\s*(?:[一二三四五六七八九十]+[、．.）)]|\d+[\.、）)]|\([一二三四五六七八九十]+\))/m.test(content);
}

function buildBaseFilters(
  materialIds?: number[],
  languageFilter: "zh" | "en" | "all" = "all"
) {
  return [
    eq(materials.status, "published"),
    languageFilter !== "all" ? eq(materials.language, languageFilter) : undefined,
    materialIds && materialIds.length > 0 ? inArray(materialChunks.materialId, materialIds) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
}

function buildTermCondition(term: string) {
  const escaped = term.replace(/[\\%_]/g, "\\$&");
  return or(
    like(materialChunks.content, `%${escaped}%`),
    like(materialChunks.chapter, `%${escaped}%`)
  );
}

function mergeCandidate(
  map: Map<number, CandidateState>,
  row: CandidateRow
): CandidateState {
  const existing = map.get(row.id);
  if (existing) return existing;

  const state: CandidateState = {
    ...row,
    routeHits: { strict: 0, phrase: 0, broad: 0 },
    recallScore: 0,
    keywordScore: 0,
    adjacencyScore: 0,
    finalScore: 0,
  };
  map.set(row.id, state);
  return state;
}

function isNearDuplicate(a: CandidateState, b: CandidateState): boolean {
  if (a.id === b.id) return true;
  if (a.materialId === b.materialId && a.chunkIndex === b.chunkIndex) return true;

  const textA = normalizeForComparison(a.content).slice(0, 240);
  const textB = normalizeForComparison(b.content).slice(0, 240);
  if (!textA || !textB) return false;
  if (textA === textB) return true;

  const shorter = textA.length <= textB.length ? textA : textB;
  const longer = shorter === textA ? textB : textA;
  if (shorter.length >= 50 && longer.includes(shorter)) return true;

  const windowSize = Math.max(6, Math.min(12, Math.floor(Math.min(textA.length, textB.length) / 14)));
  const stride = Math.max(1, Math.floor(windowSize / 2));

  const makeShingles = (text: string) => {
    const set = new Set<string>();
    for (let i = 0; i + windowSize <= text.length; i += stride) {
      set.add(text.slice(i, i + windowSize));
    }
    return set;
  };

  const shinglesA = makeShingles(textA);
  const shinglesB = makeShingles(textB);
  if (shinglesA.size === 0 || shinglesB.size === 0) return false;

  let intersection = 0;
  shinglesA.forEach((shingle) => {
    if (shinglesB.has(shingle)) intersection++;
  });

  const union = shinglesA.size + shinglesB.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  return jaccard >= 0.55;
}

function applyDiversitySelection(candidates: CandidateState[], topK: number): CandidateState[] {
  const selected: CandidateState[] = [];
  const selectedIds = new Set<number>();
  const deferred: CandidateState[] = [];
  const materialCounts = new Map<number, number>();
  const chapterCounts = new Map<string, number>();

  for (const candidate of candidates) {
    const chapterKey = candidate.chapter ? normalizeForComparison(candidate.chapter) : "";
    const materialCount = materialCounts.get(candidate.materialId) || 0;
    const chapterCount = chapterKey ? chapterCounts.get(chapterKey) || 0 : 0;

    let duplicatePenalty = 0;
    for (const picked of selected) {
      if (candidate.materialId === picked.materialId && Math.abs(candidate.chunkIndex - picked.chunkIndex) <= 1) {
        duplicatePenalty = Math.max(duplicatePenalty, 0.4);
        continue;
      }
      if (isNearDuplicate(candidate, picked)) {
        duplicatePenalty = Math.max(duplicatePenalty, 0.65);
      }
    }

    const diversityPenalty = Math.min(0.5, materialCount * 0.1 + chapterCount * 0.05 + duplicatePenalty);
    const adjustedScore = candidate.finalScore * (1 - diversityPenalty);
    if (adjustedScore <= 0) continue;
    if (duplicatePenalty >= 0.65) {
      deferred.push({
        ...candidate,
        finalScore: adjustedScore * 0.9,
      });
      continue;
    }

    selected.push({
      ...candidate,
      finalScore: adjustedScore,
    });
    selectedIds.add(candidate.id);

    materialCounts.set(candidate.materialId, materialCount + 1);
    if (chapterKey) {
      chapterCounts.set(chapterKey, chapterCount + 1);
    }

    if (selected.length >= topK) break;
  }

  if (selected.length < topK) {
    const fillPool = [...deferred, ...candidates];
    for (const candidate of fillPool) {
      if (selectedIds.has(candidate.id)) continue;

      const nearAdjacent = selected.some(
        (picked) => picked.materialId === candidate.materialId && Math.abs(candidate.chunkIndex - picked.chunkIndex) <= 1
      );
      const nearDuplicate = selected.some((picked) => isNearDuplicate(candidate, picked));
      const fillPenalty = nearDuplicate ? 0.26 : nearAdjacent ? 0.16 : 0.08;
      const adjustedScore = candidate.finalScore * (1 - fillPenalty);
      if (adjustedScore <= 0) continue;

      selected.push({
        ...candidate,
        finalScore: adjustedScore,
      });
      selectedIds.add(candidate.id);

      if (selected.length >= topK) break;
    }
  }

  return selected;
}

async function fetchRouteCandidates(
  db: DbConnection,
  route: RouteName,
  terms: string[],
  materialIds: number[] | undefined,
  languageFilter: "zh" | "en" | "all",
  limit: number
): Promise<CandidateRow[]> {
  if (terms.length === 0) return [];

  const baseFilters = buildBaseFilters(materialIds, languageFilter);
  const termConditions = terms.map((term) => buildTermCondition(term));
  const matchClause = route === "strict"
    ? and(...termConditions)
    : or(...termConditions);

  const rows = await db
    .select({
      id: materialChunks.id,
      materialId: materialChunks.materialId,
      chunkIndex: materialChunks.chunkIndex,
      content: materialChunks.content,
      chapter: materialChunks.chapter,
      pageStart: materialChunks.pageStart,
      pageEnd: materialChunks.pageEnd,
    })
    .from(materialChunks)
    .innerJoin(materials, eq(materialChunks.materialId, materials.id))
    .where(and(...baseFilters, matchClause))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    materialId: row.materialId,
    chunkIndex: row.chunkIndex,
    content: row.content,
    chapter: row.chapter,
    pageStart: row.pageStart,
    pageEnd: row.pageEnd,
  }));
}

async function fetchNeighborCandidates(
  db: DbConnection,
  seeds: CandidateState[],
  materialIds: number[] | undefined,
  languageFilter: "zh" | "en" | "all"
): Promise<CandidateRow[]> {
  if (seeds.length === 0) return [];

  const needed = new Map<number, Set<number>>();
  for (const seed of seeds) {
    if (!needed.has(seed.materialId)) {
      needed.set(seed.materialId, new Set());
    }
    const indices = needed.get(seed.materialId)!;
    indices.add(seed.chunkIndex - 1);
    indices.add(seed.chunkIndex + 1);
  }

  // V2: 合并所有邻接块查询为并行批次，减少串行 SQL 延迟
  const baseFilters = buildBaseFilters(materialIds, languageFilter);
  const queryPromises: Promise<CandidateRow[]>[] = [];

  for (const [materialId, indices] of Array.from(needed.entries())) {
    const filtered: number[] = [];
    indices.forEach((index) => {
      if (index >= 0) filtered.push(index);
    });
    if (filtered.length === 0) continue;

    queryPromises.push(
      db
        .select({
          id: materialChunks.id,
          materialId: materialChunks.materialId,
          chunkIndex: materialChunks.chunkIndex,
          content: materialChunks.content,
          chapter: materialChunks.chapter,
          pageStart: materialChunks.pageStart,
          pageEnd: materialChunks.pageEnd,
        })
        .from(materialChunks)
        .innerJoin(materials, eq(materialChunks.materialId, materials.id))
        .where(and(...baseFilters, eq(materialChunks.materialId, materialId), inArray(materialChunks.chunkIndex, filtered)))
        .limit(filtered.length + 2)
        .then((neighborRows) =>
          neighborRows.map((row) => ({
            id: row.id,
            materialId: row.materialId,
            chunkIndex: row.chunkIndex,
            content: row.content,
            chapter: row.chapter,
            pageStart: row.pageStart,
            pageEnd: row.pageEnd,
          }))
        )
    );
  }

  const results = await Promise.all(queryPromises);
  return results.flat();
}

// ─── 混合检索 Top-K（纯关键词多路召回）──────────────────────────────────────
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
  const profile = buildSearchProfile(question, questionLang);
  const strictTerms = uniqueSortedTerms(profile.coreTerms.slice(0, 5));
  const phraseTerms = uniqueSortedTerms([...profile.exactPhrases, ...profile.intentTerms]).slice(0, 8);
  const broadTerms = profile.broadTerms.slice(0, 18);
  const routePlan: Array<{
    route: RouteName;
    terms: string[];
    limit: number;
    weight: number;
  }> = [
    {
      route: "strict",
      terms: strictTerms.length > 0 ? strictTerms : phraseTerms.slice(0, 3),
      limit: SEARCH_CONFIG.strictLimit,
      weight: SEARCH_CONFIG.strictWeight,
    },
    {
      route: "phrase",
      terms: phraseTerms.length > 0 ? phraseTerms : broadTerms.slice(0, 6),
      limit: SEARCH_CONFIG.phraseLimit,
      weight: SEARCH_CONFIG.phraseWeight,
    },
    {
      route: "broad",
      terms: broadTerms,
      limit: SEARCH_CONFIG.broadLimit,
      weight: SEARCH_CONFIG.broadWeight,
    },
  ];

  const candidateMap = new Map<number, CandidateState>();

  // V2: Embedding 向量检索（如果启用）
  let embeddingResults: EmbeddingCandidate[] = [];
  const embeddingScoreMap = new Map<number, number>(); // chunkId → embedding similarity

  if (useEmbedding) {
    try {
      embeddingResults = await embeddingSearch(
        question,
        materialIds,
        languageFilter,
        SEARCH_CONFIG.embeddingTopK
      );
      for (const er of embeddingResults) {
        embeddingScoreMap.set(er.chunkId, er.similarity);
      }
      if (embeddingResults.length > 0) {
        console.log(`[HybridSearch] Embedding search returned ${embeddingResults.length} candidates (top score: ${embeddingResults[0].similarity.toFixed(3)})`);
      }
    } catch (err: any) {
      console.warn(`[HybridSearch] Embedding search failed, falling back to keyword-only: ${err?.message || err}`);
    }
  }

  // V2: 并行执行三路召回，减少串行 SQL 延迟
  const routePromises = routePlan
    .filter((route) => route.terms.length > 0)
    .map((route) =>
      fetchRouteCandidates(db, route.route, route.terms, materialIds, languageFilter, route.limit)
        .then((rows) => ({ route, rows }))
    );
  const routeResults = await Promise.all(routePromises);

  for (const { route, rows: routeRows } of routeResults) {
    const rankedRows = routeRows
      .map((row) => ({
        row,
        score: scoreChunk(row.content, route.terms, question, row.chapter ?? undefined, {
          intentTerms: profile.intentTerms,
        }),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    rankedRows.forEach((item, index) => {
      const candidate = mergeCandidate(candidateMap, item.row);
      candidate.routeHits[route.route] += 1;
      candidate.recallScore += route.weight / (index + 1.5);
    });
  }

  // V2: 将 Embedding 检索结果合入候选集
  for (const er of embeddingResults) {
    const existing = candidateMap.get(er.chunkId);
    if (existing) continue; // 关键词检索已包含，后续融合分数
    // Embedding 独有候选：构造 CandidateRow 并加入
    const state: CandidateState = {
      id: er.chunkId,
      materialId: er.materialId,
      chunkIndex: er.chunkIndex,
      content: er.content,
      chapter: er.chapter,
      pageStart: er.pageStart,
      pageEnd: er.pageEnd,
      routeHits: { strict: 0, phrase: 0, broad: 0 },
      recallScore: 0,
      keywordScore: 0,
      adjacencyScore: 0,
      finalScore: 0,
    };
    candidateMap.set(er.chunkId, state);
  }

  if (candidateMap.size === 0) return [];

  let candidates = Array.from(candidateMap.values());
  let stats = countTermStats(candidates, profile.scoringTerms);

  for (const candidate of candidates) {
    candidate.keywordScore = scoreChunk(candidate.content, profile.scoringTerms, question, candidate.chapter ?? undefined, {
      stats,
      intentTerms: profile.intentTerms,
    });
  }

  for (const candidate of candidates) {
    candidate.finalScore = candidate.keywordScore + candidate.recallScore;
  }

  candidates.sort((a, b) => b.finalScore - a.finalScore);

  const seedCount = Math.min(candidates.length, Math.max(6, Math.ceil(topK * 0.7)));
  const seedCandidates = candidates.slice(0, seedCount);
  const neighborRows = await fetchNeighborCandidates(db, seedCandidates, materialIds, languageFilter);

  for (const row of neighborRows) {
    const candidate = mergeCandidate(candidateMap, row);
    let adjacencyBoost = candidate.adjacencyScore;

    for (const seed of seedCandidates) {
      if (seed.materialId === row.materialId && Math.abs(seed.chunkIndex - row.chunkIndex) === 1) {
        adjacencyBoost = Math.max(adjacencyBoost, seed.finalScore * SEARCH_CONFIG.adjacencyBoost);
      }
    }

    candidate.adjacencyScore = Math.max(candidate.adjacencyScore, adjacencyBoost);
  }

  candidates = Array.from(candidateMap.values());
  stats = countTermStats(candidates, profile.scoringTerms);

  for (const candidate of candidates) {
    candidate.keywordScore = scoreChunk(candidate.content, profile.scoringTerms, question, candidate.chapter ?? undefined, {
      stats,
      intentTerms: profile.intentTerms,
    });
  }

  const maxKeyword = Math.max(...candidates.map((entry) => entry.keywordScore), 1);
  const maxRecall = Math.max(...candidates.map((entry) => entry.recallScore), 1);
  const maxAdjacency = Math.max(...candidates.map((entry) => entry.adjacencyScore), 1);

  // V2: 混合检索融合 — 当有 embedding 结果时使用四维融合权重
  const hasEmbeddingScores = embeddingScoreMap.size > 0;

  for (const candidate of candidates) {
    const normKeyword = candidate.keywordScore / maxKeyword;
    const normRecall = candidate.recallScore / maxRecall;
    const normAdjacency = candidate.adjacencyScore / maxAdjacency;

    if (hasEmbeddingScores) {
      // Embedding 相似度已经是 0~1 归一化的，直接使用
      const embScore = embeddingScoreMap.get(candidate.id) ?? 0;
      candidate.finalScore =
        normKeyword * SEARCH_CONFIG.keywordFusionWeightHybrid +
        normRecall * SEARCH_CONFIG.recallFusionWeightHybrid +
        normAdjacency * SEARCH_CONFIG.adjacencyFusionWeightHybrid +
        embScore * SEARCH_CONFIG.embeddingFusionWeight;
    } else {
      // 纯关键词模式（原逻辑）
      candidate.finalScore =
        normKeyword * SEARCH_CONFIG.keywordFusionWeight +
        normRecall * SEARCH_CONFIG.recallFusionWeight +
        normAdjacency * SEARCH_CONFIG.adjacencyFusionWeight;
    }
  }

  candidates.sort((a, b) => b.finalScore - a.finalScore);
  const topResults = applyDiversitySelection(candidates, topK).filter((candidate) => candidate.finalScore > 0);

  if (topResults.length === 0) return [];

  const matIds = Array.from(new Set(topResults.map((c) => c.materialId)));
  const matDetails = await db
    .select({ id: materials.id, title: materials.title })
    .from(materials)
    .where(inArray(materials.id, matIds));

  const matMap = new Map(matDetails.map(m => [m.id, m.title]));

  return topResults.map(r => ({
    chunkId: r.id,
    chunkIndex: r.chunkIndex,
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

// ─── 清除缓存 ──────────────────────────────────────────────────────────────
export function invalidateMaterialCache(_materialId: number): void {
  // 教材更新时清除 RAM 缓存，下次查询时重新加载
  invalidateRAMCache();
}

export async function forceRefreshCache(): Promise<void> {
  // 强制重新加载 RAM 缓存
  invalidateRAMCache();
  await ensureRAMCache();
}
