import {
  semanticSearch,
  extractKeywords,
  extractKeywordsEn,
  type SearchResult,
} from "./vectorSearch";
import { invokeLLMWithConfig } from "./llmDriver";
import { createQuery, upsertVisitorStat } from "./db";
import { detectLanguage } from "./languageDetect";
import type { QuerySource } from "../drizzle/schema";

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
2. If not covered, set found_in_materials=false and answer clearly that the content is not covered in the provided textbook.
3. If multiple viewpoints exist, list all of them.
4. Keep wording aligned with textbook terminology.
5. Use **bold** (Markdown) to highlight key terms, definitions, and important concepts in your answer.
6. Return JSON only:
{ "answer": "...", "found_in_materials": true/false, "confidence": 0-1, "citation_indices": [] }`;
  }

  if (materialLang === "en") {
    return `你是一位森林培育学助教。以下是英文教材的相关段落。
请基于这些英文教材内容，用中文回答问题。回答时：
1. 先给出英文教材的关键原文（1-2句）
2. 再给出中文翻译和解释

规则：
- 只能基于提供的教材内容回答，不能使用教材以外的知识
- 如果教材中没有相关内容，设 found_in_materials=false
- confidence 表示答案与教材内容的匹配程度（0-1）
- 使用 **加粗**（Markdown格式）标记关键术语和重要概念

返回 JSON：{ "answer": "...", "found_in_materials": true/false, "confidence": 0-1, "citation_indices": [] }`;
  }

  const titleList = materialTitles.length
    ? materialTitles.map((t, i) => `  ${i + 1}. 《${t}》`).join("\n")
    : "  （暂无已发布教材）";

  return `你是北京林业大学森林培育学科的专业教学助手，严格基于以下教材内容回答学生问题：
${titleList}

规则：
1. 只能基于提供的教材片段回答。
2. 不得使用教材外知识。
3. 若教材未涉及，found_in_materials=false，且明确说明”教材中未涉及此内容”。
4. 如果有多个观点，必须完整列出。
5. 使用 **加粗**（Markdown格式）标记答案中的关键术语、定义和重要概念，便于学生快速抓住重点。
6. 返回 JSON：{ “answer”: “...”, “found_in_materials”: true/false, “confidence”: 0-1, “citation_indices”: [] }`;
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
    return `Question:\n${question}\n\nTextbook excerpts (${chunks.length}):\n${chunkTexts}\n\nPlease answer in JSON.`;
  }

  return `【学生问题】\n${question}\n\n【教材内容片段（共 ${chunks.length} 条）】\n${chunkTexts}\n\n请根据以上教材内容，以 JSON 格式回答。`;
}

export async function generateAnswer(req: QARequest): Promise<QAResponse> {
  const startTime = Date.now();
  const questionLanguage = detectLanguage(req.question);

  let mainResult: CallLLMResult;
  let enAnswer: string | undefined;
  let enSources: QuerySource[] | undefined;

  if (questionLanguage === "en") {
    const enResults = await semanticSearch(req.question, undefined, 8, "en");
    mainResult = await callLLM(req.question, enResults, "en", "en");
  } else {
    const [zhResults, enResults] = await Promise.all([
      semanticSearch(req.question, undefined, 8, "zh"),
      semanticSearch(req.question, undefined, 5, "en"),
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

  const responseTimeMs = Date.now() - startTime;

  const queryId = await createQuery({
    question: req.question,
    answer: mainResult.answer,
    sources: mainResult.sources,
    modelUsed: mainResult.modelUsed,
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

  const parsed = parseLLMOutput(llmResponse.content);

  let answer = llmResponse.content;
  let foundInMaterials = true;
  let confidence = 0.6;
  let usedSources = searchResults;

  if (parsed) {
    answer = parsed.answer;
    foundInMaterials = parsed.found_in_materials;
    confidence = parsed.confidence;

    if (parsed.citation_indices && parsed.citation_indices.length > 0) {
      usedSources = parsed.citation_indices
        .filter((idx) => idx >= 1 && idx <= searchResults.length)
        .map((idx) => searchResults[idx - 1]);
      usedSources = usedSources.filter(
        (s, i, arr) => arr.findIndex((x) => x.chunkId === s.chunkId) === i
      );
    }

    if (!foundInMaterials) {
      if (questionLang === "en" && !answer.toLowerCase().includes("not cover")) {
        answer = "The provided textbook excerpts do not cover this topic.";
      }
      if (questionLang === "zh" && !answer.includes("教材中未涉及")) {
        answer = "教材中未涉及此内容。建议查阅其他章节或咨询教师。";
      }
      usedSources = [];
    }
  }

  const keywords = questionLang === "en" ? extractKeywordsEn(question) : extractKeywords(question);

  const sources: QuerySource[] = usedSources.map((r) => ({
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
    confidence,
  };
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
