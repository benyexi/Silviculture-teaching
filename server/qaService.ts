import {
  semanticSearch,
  extractKeywords,
  extractKeywordsEn,
  type SearchResult,
} from "./vectorSearch";
import { invokeLLMWithConfig } from "./llmDriver";
import { createQuery, upsertVisitorStat, getActiveLlmConfig } from "./db";
import { detectLanguage } from "./languageDetect";
import type { QuerySource } from "../drizzle/schema";

// ─── 答案缓存 ─────────────────────────────────────────────────────────────────
type CachedAnswer = {
  mainResult: CallLLMResult;
  enAnswer?: string;
  enSources?: QuerySource[];
  questionLanguage: "zh" | "en";
  cachedAt: number;
};

const CACHE_TTL_MS = 30 * 60 * 1000; // 缓存 30 分钟
const CACHE_MAX_SIZE = 500; // 最多缓存 500 条
const answerCache = new Map<string, CachedAnswer>();

function normalizeQuestion(q: string): string {
  return q
    .trim()
    .toLowerCase()
    .replace(/[，。？！、；：""''（）【】《》\s]+/g, "")
    .replace(/[?,;:!"'()\[\]\s]+/g, "");
}

function getCachedAnswer(question: string): CachedAnswer | null {
  const key = normalizeQuestion(question);
  const cached = answerCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
    answerCache.delete(key);
    return null;
  }
  return cached;
}

function setCachedAnswer(question: string, data: Omit<CachedAnswer, "cachedAt">): void {
  // 超出容量时清理最旧的条目
  if (answerCache.size >= CACHE_MAX_SIZE) {
    const firstKey = answerCache.keys().next().value;
    if (firstKey !== undefined) answerCache.delete(firstKey);
  }
  answerCache.set(normalizeQuestion(question), { ...data, cachedAt: Date.now() });
}

/** 教材更新时清空缓存，保证答案基于最新教材 */
export function clearAnswerCache(): void {
  answerCache.clear();
  console.log("[Cache] Answer cache cleared");
}

export type QARequest = {
  question: string;
  visitorIp?: string;
  visitorCity?: string;
  visitorRegion?: string;
  visitorCountry?: string;
  visitorLat?: number;
  visitorLng?: number;
};

export type QAResponse = {
  answer: string;
  sources: QuerySource[];
  modelUsed: string;
  responseTimeMs: number;
  queryId: number;
  foundInMaterials: boolean;
  confidence: number;
  questionLanguage: "zh" | "en";
  enAnswer?: string;
  enSources?: QuerySource[];
};

type LLMStructuredOutput = {
  answer: string;
  found_in_materials: boolean;
  citation_indices: number[];
  confidence: number;
};

type CallLLMResult = {
  answer: string;
  sources: QuerySource[];
  modelUsed: string;
  foundInMaterials: boolean;
  confidence: number;
};

export function buildSystemPrompt(
  materialTitles: string[],
  questionLang: "zh" | "en" = "zh",
  materialLang: "zh" | "en" = "zh"
): string {
  if (questionLang === "en") {
    const titleList = materialTitles.length
      ? materialTitles.map((t) => `- ${t}`).join("\n")
      : "- (No textbook excerpts)";

    return `You are a silviculture teaching assistant. Answer questions based ONLY on the provided textbook excerpts.

Textbooks:
${titleList}

Rules:
1. Use only the provided excerpts. Do not add outside knowledge.
2. Synthesize and organize information from the excerpts into a clear, comprehensive answer with headings and bullet points.
3. If the content is not covered in the excerpts, reply: "The provided textbook excerpts do not cover this topic."
4. If multiple viewpoints exist, list all of them.
5. Use **bold** (Markdown) to highlight key terms and definitions.
6. Output your answer directly in Markdown format. Do NOT wrap it in JSON or code blocks.`;
  }

  if (materialLang === "en") {
    return `你是一位森林培育学助教。以下是英文教材的相关段落。
请基于这些英文教材内容，用中文回答问题。回答时：
1. 先给出英文教材的关键原文（1-2句）
2. 再给出中文翻译和解释

规则：
- 只能基于提供的教材内容回答，不能使用教材以外的知识
- 如果教材中没有相关内容，回复"教材中未涉及此内容"
- 使用 **加粗**（Markdown格式）标记关键术语和重要概念
- 直接输出 Markdown 格式的回答，不要包裹在 JSON 或代码块中`;
  }

  const titleList = materialTitles.length
    ? materialTitles.map((t, i) => `  ${i + 1}. 《${t}》`).join("\n")
    : "  （暂无已发布教材）";

  return `你是北京林业大学森林培育学科的专业教学助手，严格基于以下教材内容回答学生问题：
${titleList}

规则：
1. 只能基于提供的教材片段回答，不得使用教材外知识。
2. 综合整理教材片段中的信息，给出结构清晰、内容完整的回答。使用标题（如 一、二、三）和列表组织内容，条理分明。
3. 若教材未涉及该内容，明确回复"教材中未涉及此内容"。
4. 如果教材中有多个观点或说法，应完整列出。
5. 使用 **加粗**（Markdown格式）标记关键术语和重要概念。
6. 直接输出 Markdown 格式的回答，不要包裹在 JSON 或代码块中。`;
}

export function buildUserPrompt(
  question: string,
  chunks: SearchResult[],
  questionLang: "zh" | "en" = "zh"
): string {
  const chunkTexts = chunks
    .map((r, idx) => {
      const location = [
        `《${r.materialTitle}》`,
        r.chapter ? r.chapter : null,
        r.pageStart
          ? `第${r.pageStart}页${r.pageEnd && r.pageEnd !== r.pageStart ? `~${r.pageEnd}页` : ""}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");

      return `[引用${idx + 1}] 来源：${location}\n${r.content}`;
    })
    .join("\n\n---\n\n");

  if (questionLang === "en") {
    return `Question:\n${question}\n\nTextbook excerpts (${chunks.length}):\n${chunkTexts}\n\nPlease answer based on the excerpts above.`;
  }

  return `【学生问题】\n${question}\n\n【教材内容片段（共 ${chunks.length} 条）】\n${chunkTexts}\n\n请根据以上教材内容回答。`;
}

export async function generateAnswer(req: QARequest): Promise<QAResponse> {
  const startTime = Date.now();
  const questionLanguage = detectLanguage(req.question);

  // 检查当前配置是否启用了 RAG 模式
  const activeConfig = await getActiveLlmConfig();
  const useRAG = activeConfig?.useRAG ?? false;

  let mainResult: CallLLMResult;
  let enAnswer: string | undefined;
  let enSources: QuerySource[] | undefined;
  let fromCache = false;

  // 检查缓存
  const cached = getCachedAnswer(req.question);
  if (cached) {
    mainResult = cached.mainResult;
    enAnswer = cached.enAnswer;
    enSources = cached.enSources;
    fromCache = true;
  } else {
    // useRAG=true: 关键词+向量混合检索; useRAG=false: 仅关键词检索（两者都搜教材）
    if (questionLanguage === "en") {
      const enResults = await semanticSearch(req.question, undefined, 8, "en", useRAG);
      mainResult = await callLLM(req.question, enResults, "en", "en");
    } else {
      const [zhResults, enResults] = await Promise.all([
        semanticSearch(req.question, undefined, 8, "zh", useRAG),
        semanticSearch(req.question, undefined, 5, "en", useRAG),
      ]);

      mainResult = await callLLM(req.question, zhResults, "zh", "zh");

      if (enResults.length > 0) {
        const enResult = await callLLM(req.question, enResults, "zh", "en");
        if (enResult.foundInMaterials) {
          enAnswer = enResult.answer;
          enSources = enResult.sources;
        }
      }
    }

    // 只缓存教材中找到内容的答案
    if (mainResult.foundInMaterials) {
      setCachedAnswer(req.question, { mainResult, enAnswer, enSources, questionLanguage });
    }
  }

  const responseTimeMs = Date.now() - startTime;

  const queryId = await createQuery({
    question: req.question,
    answer: mainResult.answer,
    sources: mainResult.sources,
    modelUsed: fromCache ? `${mainResult.modelUsed}(cached)` : mainResult.modelUsed,
    responseTimeMs,
    visitorIp: req.visitorIp,
    visitorCity: req.visitorCity,
    visitorRegion: req.visitorRegion,
    visitorCountry: req.visitorCountry,
    visitorLat: req.visitorLat,
    visitorLng: req.visitorLng,
  });

  const today = new Date().toISOString().split("T")[0];
  const cityDist = req.visitorCity ? { [req.visitorCity]: 1 } : {};
  const countryDist = req.visitorCountry ? { [req.visitorCountry]: 1 } : {};
  upsertVisitorStat(today, cityDist, countryDist).catch(console.error);

  return {
    ...mainResult,
    responseTimeMs,
    queryId,
    questionLanguage,
    enAnswer,
    enSources,
  };
}

async function callLLM(
  question: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  materialLang: "zh" | "en"
): Promise<CallLLMResult> {
  if (searchResults.length === 0) {
    const answer =
      questionLang === "en"
        ? "The provided textbook excerpts do not cover this topic."
        : "教材中未涉及此内容。建议查阅其他章节或咨询教师。";

    return {
      answer,
      sources: [],
      modelUsed: "built-in",
      foundInMaterials: false,
      confidence: 0,
    };
  }

  const materialTitles = Array.from(new Set(searchResults.map((r) => r.materialTitle)));
  const systemPrompt = buildSystemPrompt(materialTitles, questionLang, materialLang);
  const userMessage = buildUserPrompt(question, searchResults, questionLang);

  const llmResponse = await invokeLLMWithConfig(
    [{ role: "user", content: userMessage }],
    systemPrompt
  );

  let answer = stripCitationMarkers(llmResponse.content);

  // 如果 LLM 仍然返回了 JSON，提取 answer 字段
  const parsed = parseLLMOutput(llmResponse.content);
  if (parsed) {
    answer = stripCitationMarkers(parsed.answer);
  }

  // 判断是否在教材中找到了内容
  const notFoundPhrases = ["未涉及", "not cover", "没有相关", "未找到", "not found"];
  const foundInMaterials = !notFoundPhrases.some((p) => answer.toLowerCase().includes(p));

  const keywords = questionLang === "en" ? extractKeywordsEn(question) : extractKeywords(question);

  const sources: QuerySource[] = (foundInMaterials ? searchResults : []).map((r) => ({
    materialId: r.materialId,
    materialTitle: r.materialTitle,
    chapter: r.chapter,
    pageStart: r.pageStart,
    pageEnd: r.pageEnd,
    excerpt: r.content.substring(0, 200) + (r.content.length > 200 ? "..." : ""),
    highlightedExcerpt: extractHighlightSentence(r.content, keywords),
  }));

  return {
    answer,
    sources,
    modelUsed: llmResponse.model,
    foundInMaterials,
    confidence: foundInMaterials ? 0.8 : 0.1,
  };
}

/** 清除 LLM 回答中残留的 citation 标记，如 [citation_indices: 3] 或 [citation_indices: 3, 6] */
function stripCitationMarkers(text: string): string {
  return text
    .replace(/\[citation_indices?:\s*[\d,\s]+\]/gi, "")
    .replace(/\[引用\d+\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseLLMOutput(content: string): LLMStructuredOutput | null {
  try {
    const parsed = JSON.parse(content.trim());
    if (isValidStructuredOutput(parsed)) return parsed;
  } catch {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        if (isValidStructuredOutput(parsed)) return parsed;
      } catch {
        // noop
      }
    }

    const objectMatch = content.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        if (isValidStructuredOutput(parsed)) return parsed;
      } catch {
        // noop
      }
    }
  }
  return null;
}

function isValidStructuredOutput(obj: unknown): obj is LLMStructuredOutput {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.answer === "string" &&
    typeof o.found_in_materials === "boolean" &&
    Array.isArray(o.citation_indices) &&
    typeof o.confidence === "number"
  );
}

function extractHighlightSentence(content: string, keywords: string[]): string {
  const sentences = content.split(/[。！？\n]/).filter((s) => s.trim().length > 10);
  let best = sentences[0] || content.substring(0, 100);
  let bestScore = 0;
  for (const sentence of sentences) {
    const score = keywords.reduce(
      (acc, kw) => acc + (sentence.toLowerCase().includes(kw.toLowerCase()) ? kw.length : 0),
      0
    );
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }
  return best.trim().substring(0, 150);
}
