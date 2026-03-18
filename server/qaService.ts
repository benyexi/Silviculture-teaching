import {
  semanticSearch,
  extractKeywords,
  extractKeywordsEn,
  type SearchResult,
} from "./vectorSearch";
import { invokeLLMWithConfig, invokeLLMStreamWithConfig } from "./llmDriver";
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

    return `You are a silviculture teaching assistant at Beijing Forestry University. Answer questions based ONLY on the provided textbook excerpts.

Textbooks:
${titleList}

Requirements:
1. **Strictly textbook-based**: Use ONLY information explicitly stated in the provided excerpts. Do NOT add outside knowledge, infer, extrapolate, or fill in details not explicitly present in the excerpts. If an excerpt only mentions a term in passing without elaboration, do not elaborate on it yourself.
2. **Relevance check**: If the provided excerpts are NOT directly relevant to the question (they merely happen to contain a word from the question but are not actually discussing that topic), reply: "The provided textbook excerpts do not cover this topic." Do not force an answer from unrelated excerpts.
3. **Comprehensive but faithful**: For excerpts that ARE relevant, synthesize them thoroughly. List every classification, method, or step mentioned with specific details from the textbook. But never add information not found in the excerpts.
4. **Well-structured**: Use multi-level headings (##, ###) and bullet points. Organize by: Definition → Classification/Types → Methods/Steps → Principles → Applications.
5. **Highlight key terms**: Use **bold** for key terms, important concepts, and critical conclusions. Precisely cite data, formulas, and ratios from the textbook.
6. **Preserve textbook language**: Use original terminology from the textbooks. Every statement must be traceable to the provided excerpts. If multiple viewpoints exist, list all of them.
7. **Format**: Output directly in Markdown. Start with a 1-2 sentence overview, then expand with full details. Do NOT wrap in JSON or code blocks.
8. **No citation markers**: Do NOT include "[引用1]", "[citation]", or any reference markers in your answer. Just state the content directly.`;
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

回答要求：
1. **严格基于教材原文**：只能基于提供的教材片段中**明确写出的内容**回答，绝对不得使用教材外知识，不得自行推理、延伸、补充或编造任何教材中没有明确陈述的内容。如果片段中只是顺带提到某个概念但没有详细展开，不要自行补充细节。
2. **判断相关性**：如果提供的教材片段与学生问题**不直接相关**（片段只是偶然包含了问题中的某个词，但并非在讨论该主题），应回复"教材中未涉及此内容"。不要勉强从不相关的片段中拼凑答案。
3. **全面但忠实**：对于确实相关的片段，综合其信息给出全面回答。对于教材中提到的分类、类型、方法、步骤等，完整列出每一项并给出教材中的具体说明。但绝不添加教材片段中没有的信息。
4. **结构清晰**：使用多级标题组织内容（如"## 一、xxx"、"### （一）xxx"），善用列表和缩进体现层次关系。按照"定义与概述→分类/类型→具体方法/步骤→原则与注意事项→应用场景"等逻辑顺序组织。
5. **突出重点**：使用 **加粗** 标记关键术语、重要概念和核心结论。对于教材中的数据、公式、比例等要精确引用。
6. **保留教材表述**：必须使用教材中的原始术语和表述。可以适当组织结构，但每一句话的信息都必须能在提供的片段中找到出处。如果教材中有多个观点或说法，应完整列出。
7. **格式规范**：直接输出 Markdown 格式，不要包裹在 JSON 或代码块中。开头先用1-2句话概括主题，再展开详细内容。
8. **禁止引用标记**：回答中绝对不要出现"[引用1]"、"[引用2]"等引用编号标记，也不要出现"片段[引用N]"、"[citation]"等任何形式的引用标注。直接陈述内容即可。`;
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

      return `【片段${idx + 1}】来源：${location}\n${r.content}`;
    })
    .join("\n\n---\n\n");

  if (questionLang === "en") {
    return `Question:\n${question}\n\nTextbook excerpts (${chunks.length}):\n${chunkTexts}\n\nPlease answer based on the excerpts above.`;
  }

  return `【学生问题】\n${question}\n\n【教材内容片段（共 ${chunks.length} 条）】\n${chunkTexts}\n\n请综合以上所有教材片段，给出全面、详尽、结构清晰的回答。不要遗漏任何片段中的相关信息。`;
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
        semanticSearch(req.question, undefined, 20, "zh", useRAG),
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

  // 判断是否在教材中找到了内容（只检查开头50字，避免中间提到"未涉及"被误判）
  const notFoundPhrases = ["未涉及", "not cover", "没有相关", "未找到", "not found"];
  const answerStart = answer.substring(0, 50).toLowerCase();
  const foundInMaterials = !notFoundPhrases.some((p) => answerStart.includes(p));

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

/** 清除 LLM 回答中残留的 citation 标记 */
function stripCitationMarkers(text: string): string {
  return text
    .replace(/\[citation_indices?:\s*[\d,\s]+\]/gi, "")
    .replace(/\[引用\d+\]/g, "")
    .replace(/【?片段\d+】?/g, "")
    .replace(/片段\[?\d+\]?至?\[?\d*\]?/g, "")
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

// ─── 流式答案生成 ─────────────────────────────────────────────────────────────

export type StreamMeta = {
  sources: QuerySource[];
  modelUsed: string;
  foundInMaterials: boolean;
  confidence: number;
  questionLanguage: "zh" | "en";
  queryId?: number;
  responseTimeMs?: number;
};

/**
 * 流式生成答案：先检索教材，然后通过 SSE 逐步输出 LLM 回答。
 * onToken: 每生成一个 token 就调用
 * onMeta: 在开始流式输出前发送元数据（sources 等）
 * onDone: 完成时调用
 */
export async function generateAnswerStream(
  req: QARequest,
  onMeta: (meta: StreamMeta) => void,
  onToken: (token: string) => void,
  onDone: (fullAnswer: string) => void,
  onError: (error: string) => void
): Promise<void> {
  const startTime = Date.now();
  const questionLanguage = detectLanguage(req.question);
  const activeConfig = await getActiveLlmConfig();
  const useRAG = activeConfig?.useRAG ?? false;

  // 检查缓存
  const cached = getCachedAnswer(req.question);
  if (cached) {
    const responseTimeMs = Date.now() - startTime;
    const queryId = await createQuery({
      question: req.question,
      answer: cached.mainResult.answer,
      sources: cached.mainResult.sources,
      modelUsed: `${cached.mainResult.modelUsed}(cached)`,
      responseTimeMs,
      visitorIp: req.visitorIp,
      visitorCity: req.visitorCity,
      visitorRegion: req.visitorRegion,
      visitorCountry: req.visitorCountry,
      visitorLat: req.visitorLat,
      visitorLng: req.visitorLng,
    });
    onMeta({
      sources: cached.mainResult.sources,
      modelUsed: `${cached.mainResult.modelUsed}(cached)`,
      foundInMaterials: cached.mainResult.foundInMaterials,
      confidence: cached.mainResult.confidence,
      questionLanguage,
      queryId,
      responseTimeMs,
    });
    // 对于缓存的答案，快速逐段输出以模拟流式效果
    onToken(cached.mainResult.answer);
    onDone(cached.mainResult.answer);
    return;
  }

  try {
    // 检索教材
    let searchResults: SearchResult[];
    if (questionLanguage === "en") {
      searchResults = await semanticSearch(req.question, undefined, 8, "en", useRAG);
    } else {
      searchResults = await semanticSearch(req.question, undefined, 20, "zh", useRAG);
    }

    if (searchResults.length === 0) {
      const answer = questionLanguage === "en"
        ? "The provided textbook excerpts do not cover this topic."
        : "教材中未涉及此内容。建议查阅其他章节或咨询教师。";
      onMeta({
        sources: [],
        modelUsed: "built-in",
        foundInMaterials: false,
        confidence: 0,
        questionLanguage,
      });
      onToken(answer);
      onDone(answer);
      return;
    }

    const materialTitles = Array.from(new Set(searchResults.map((r) => r.materialTitle)));
    const systemPrompt = buildSystemPrompt(materialTitles, questionLanguage, questionLanguage);
    const userMessage = buildUserPrompt(req.question, searchResults, questionLanguage);
    const keywords = questionLanguage === "en" ? extractKeywordsEn(req.question) : extractKeywords(req.question);

    const sources: QuerySource[] = searchResults.map((r) => ({
      materialId: r.materialId,
      materialTitle: r.materialTitle,
      chapter: r.chapter,
      pageStart: r.pageStart,
      pageEnd: r.pageEnd,
      excerpt: r.content.substring(0, 200) + (r.content.length > 200 ? "..." : ""),
      highlightedExcerpt: extractHighlightSentence(r.content, keywords),
    }));

    // 先发送元数据（sources），让前端立刻展示引用来源
    onMeta({
      sources,
      modelUsed: "",
      foundInMaterials: true,
      confidence: 0.8,
      questionLanguage,
    });

    // 流式调用 LLM
    const { stream, model } = await invokeLLMStreamWithConfig(
      [{ role: "user", content: userMessage }],
      systemPrompt
    );

    let fullAnswer = "";
    for await (const token of stream) {
      fullAnswer += token;
      onToken(token);
    }

    fullAnswer = stripCitationMarkers(fullAnswer);

    // 判断是否找到内容（只检查开头50字，避免中间提到"未涉及"被误判）
    const notFoundPhrases = ["未涉及", "not cover", "没有相关", "未找到", "not found"];
    const answerStart = fullAnswer.substring(0, 50).toLowerCase();
    const foundInMaterials = !notFoundPhrases.some((p) => answerStart.includes(p));

    const responseTimeMs = Date.now() - startTime;

    // 保存到数据库
    const queryId = await createQuery({
      question: req.question,
      answer: fullAnswer,
      sources: foundInMaterials ? sources : [],
      modelUsed: model,
      responseTimeMs,
      visitorIp: req.visitorIp,
      visitorCity: req.visitorCity,
      visitorRegion: req.visitorRegion,
      visitorCountry: req.visitorCountry,
      visitorLat: req.visitorLat,
      visitorLng: req.visitorLng,
    });

    // 缓存
    if (foundInMaterials) {
      setCachedAnswer(req.question, {
        mainResult: { answer: fullAnswer, sources, modelUsed: model, foundInMaterials, confidence: 0.8 },
        questionLanguage,
      });
    }

    // 更新访客统计
    const today = new Date().toISOString().split("T")[0];
    const cityDist = req.visitorCity ? { [req.visitorCity]: 1 } : {};
    const countryDist = req.visitorCountry ? { [req.visitorCountry]: 1 } : {};
    upsertVisitorStat(today, cityDist, countryDist).catch(console.error);

    onDone(fullAnswer);
  } catch (err: any) {
    onError(err?.message || String(err));
  }
}
