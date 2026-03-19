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

type QuestionIntent = "definition" | "classification" | "method" | "comparison" | "other";

type QuestionAnalysis = {
  intent: QuestionIntent;
  intents: QuestionIntent[];
  expectsEnumeration: boolean;
  expectsComparisonTable: boolean;
  expectsFullCoverage: boolean;
  requestDetail: boolean;
  conciseDefinition: boolean;
  conciseEntity: boolean;
  conciseAnswer: boolean;
  keywords: string[];
};

type AnswerReview = {
  complete: boolean;
  issues: string[];
  shouldRetry: boolean;
  downgradeNote: string;
};

function detectQuestionIntent(question: string, questionLang: "zh" | "en"): QuestionAnalysis {
  const q = question.toLowerCase();
  const trimmedQ = q.trim();
  const intents: QuestionIntent[] = [];

  const hasComparisonCue =
    questionLang === "zh"
      ? /(比较|对比|区别|差异|异同|有何不同|怎么区分|区分)/.test(q)
      : /(compare|difference|differences|compare and contrast|versus|vs\.?)/.test(q);

  const hasDefinitionCue =
    questionLang === "zh"
      ? /(什么是|定义|含义|概念|解释|说明|何谓|是指|指的是)/.test(q)
      : /(what is|define|definition|meaning|concept|explain)/.test(q);

  const startsWithDefinitionCue =
    questionLang === "zh"
      ? /^(什么是|何谓|是指|定义|含义|概念)/.test(trimmedQ)
      : /^(what is|define|definition of|meaning of|concept of)/.test(trimmedQ);

  const hasExplicitListCue =
    questionLang === "zh"
      ? /(有哪些|有哪|包括哪些|几类|几种|分为|可分为|列出|罗列)/.test(q)
      : /(which|what).*?(types?|kinds?|categories?|classes?)|list/.test(q);

  const hasClassificationCue =
    questionLang === "zh"
      ? (/(分类|类型|种类)/.test(q) && hasExplicitListCue) || /(有哪些分类|有哪些类型|分为|可分为|几类|几种|列出|罗列)/.test(q)
      : /(types?|kinds?|categories?|classes?|which kinds|what types|list)/.test(q);

  const hasMethodCue =
    questionLang === "zh"
      ? /(如何|怎么|怎样|步骤|流程|程序|实施|操作|方法有哪些|有哪些方法|方式有哪些|有哪些方式)/.test(q)
      : /(methods?|ways?|steps?|process|procedure|how to|how do|how should)/.test(q);

  const prioritizeDefinition =
    startsWithDefinitionCue && hasDefinitionCue && !hasComparisonCue && !hasExplicitListCue && !hasMethodCue;

  if (prioritizeDefinition) {
    intents.push("definition");
  }

  if (hasComparisonCue) {
    intents.push("comparison");
  }

  if (hasClassificationCue) {
    intents.push("classification");
  }

  if (hasMethodCue) {
    intents.push("method");
  }

  if (!prioritizeDefinition && hasDefinitionCue) {
    intents.push("definition");
  }

  if (intents.length === 0) intents.push("other");

  const requestDetail =
    questionLang === "zh"
      ? /(详细|具体|全面|系统|深入|展开|分别说明|分别阐述|论述|阐述|比较|对比分析)/.test(q)
      : /(detailed|detail|comprehensive|in depth|elaborate|analyze|analysis|compare)/.test(q);

  const compactQuestion = question
    .trim()
    .replace(/[，。？！、；：""''（）【】《》\s]+/g, "")
    .replace(/[?,;:!"'()\[\]\s]+/g, "");
  const isVeryShort =
    compactQuestion.length >= 2 &&
    (questionLang === "zh" ? compactQuestion.length <= 8 : compactQuestion.split(/\s+/).filter(Boolean).length <= 4);
  const conciseEntity = isVeryShort && !requestDetail && intents.length === 1 && intents[0] === "other";
  const intent = intents[0];
  const conciseDefinition = intent === "definition" && !requestDetail;

  return {
    intent,
    intents,
    expectsEnumeration: intents.includes("classification") || intents.includes("method"),
    expectsComparisonTable: intents.includes("comparison"),
    expectsFullCoverage: intents.some((intent) => intent !== "definition" && intent !== "other"),
    requestDetail,
    conciseDefinition,
    conciseEntity,
    conciseAnswer: conciseDefinition || conciseEntity,
    keywords: (questionLang === "en" ? extractKeywordsEn(question) : extractKeywords(question)).slice(0, 8),
  };
}

function describeIntent(intent: QuestionIntent, lang: "zh" | "en"): string {
  const zhMap: Record<QuestionIntent, string> = {
    definition: "定义题",
    classification: "分类题",
    method: "方法/步骤题",
    comparison: "比较题",
    other: "一般问答",
  };
  const enMap: Record<QuestionIntent, string> = {
    definition: "definition question",
    classification: "classification question",
    method: "method/step question",
    comparison: "comparison question",
    other: "general question",
  };
  return lang === "en" ? enMap[intent] : zhMap[intent];
}

function buildAnswerBlueprint(analysis: QuestionAnalysis, questionLang: "zh" | "en"): string {
  if (questionLang === "en") {
    switch (analysis.intent) {
      case "classification":
        return `1. Short overview\n2. Complete list of types/classes mentioned in the excerpts\n3. Item-by-item explanation\n4. Completeness note`;
      case "method":
        return `1. Short overview\n2. Complete list of methods/steps mentioned in the excerpts\n3. Details for each method/step\n4. Notes and constraints`;
      case "comparison":
        return `1. Objects being compared\n2. Side-by-side comparison table\n3. Key differences and conclusion`;
      case "definition":
        return analysis.conciseDefinition
          ? `1. One direct definition sentence\n2. 1-2 supporting sentences from excerpts\n3. Stop; no background expansion`
          : `1. Direct definition\n2. Key features or boundaries\n3. Related explanation or application`;
      default:
        if (analysis.conciseEntity) {
          return `1. Directly state what the excerpts say about the queried term/person\n2. Give 1-3 excerpt-grounded facts\n3. Stop; no expansion`;
        }
        return `1. Short overview\n2. Structured explanation\n3. Completeness note if the excerpts are partial`;
    }
  }

  switch (analysis.intent) {
    case "classification":
      return `1. 一句话概述\n2. 完整列出教材明确出现的类型/分类/条目\n3. 逐项说明每一项\n4. 说明是否存在教材未覆盖的部分`;
    case "method":
      return `1. 一句话概述\n2. 完整列出教材明确出现的方法/步骤\n3. 逐项说明每一项的条件、要点或作用\n4. 说明是否存在教材未覆盖的部分`;
    case "comparison":
      return `1. 说明比较对象\n2. 用对比表或分点对比列出差异\n3. 给出结论`;
    case "definition":
      return analysis.conciseDefinition
        ? `1. 先给出一句最直接定义\n2. 再补1-2句教材内关键说明\n3. 到此结束，不延伸历史、分类、目的等`
        : `1. 先给出定义或核心含义\n2. 补充关键特征、边界或作用\n3. 结合教材语境做简短解释`;
    default:
      if (analysis.conciseEntity) {
        return `1. 直接回答教材中关于该词/人名的明确信息\n2. 只列1-3条片段内事实\n3. 到此结束，不展开延伸`;
      }
      return `1. 简要概述\n2. 结构化展开\n3. 说明教材是否仅覆盖部分内容`;
  }
}

function buildFewShot(questionLang: "zh" | "en", analysis: QuestionAnalysis): string {
  if (analysis.intent === "definition" && analysis.conciseDefinition) {
    if (questionLang === "en") {
      return `Example (concise definition):
Q: What is silviculture?
A:
Silviculture is the discipline that studies forest cultivation theory and practice.
It covers the cultivation process from seeds/seedlings to stand establishment and maturity.
Only information explicitly stated in the excerpts is included.`;
    }

    return `示例（简洁定义题）：
用户问题：什么是森林培育？
回答：
森林培育是按既定目标和自然规律开展的综合培育活动，涵盖从种子、苗木到成林成熟的全过程。
森林培育学是研究上述培育活动理论与实践的学科。
仅回答教材明确给出的定义，不扩展历史或延伸内容。`;
  }

  if (questionLang === "en") {
    return `Examples:
Example 1 (classification):
Q: What types are mentioned?
A:
## Overview
The excerpts clearly mention several types.
## Types
1. Type A: ...
2. Type B: ...
3. Type C: ...
## Completeness note
Only the items explicitly mentioned in the excerpts are listed.

Example 2 (method):
Q: What methods or steps are described?
A:
## Overview
The excerpts provide a complete list of the described methods/steps.
## Methods / steps
1. ...
2. ...
3. ...
## Notes
If the excerpts only cover part of the topic, say so explicitly.`;
  }

  return `示例1（分类题）：
用户问题：某对象有哪些类型？
回答：
## 一、概述
教材明确出现若干类型。
## 二、类型清单
1. 第一类：...
2. 第二类：...
3. 第三类：...
## 三、完整性说明
以上仅列出教材明确出现的项目，不额外补充。

示例2（方法题）：
用户问题：某操作有哪些方法或步骤？
回答：
## 一、概述
教材给出了完整或部分的方法/步骤。
## 二、方法/步骤清单
1. ...
2. ...
3. ...
## 三、注意事项
如教材只覆盖部分内容，应明确说明。`;
}

function buildSystemHeader(
  questionLang: "zh" | "en",
  materialLang: "zh" | "en",
  analysis: QuestionAnalysis
): string {
  if (questionLang === "en") {
    const materialNote = materialLang === "en"
      ? "The excerpts are in English; answer in English."
      : "The excerpts may contain mixed-language content; answer in English.";

    return `You are a silviculture teaching assistant at Beijing Forestry University.
${materialNote}

Answering protocol:
1. First identify the intent: ${describeIntent(analysis.intent, "en")}.
2. If the question is about classifications, methods, steps, or comparisons, enumerate all items explicitly mentioned in the excerpts.
3. Do not stop at a summary sentence when the question asks for types, methods, steps, or differences.
4. If the excerpts only cover part of the topic, say so plainly and do not invent missing items.
5. Use Markdown only. Do not wrap the final answer in JSON or code fences.
6. Do not include citation markers like [citation] or [引用1].
7. Never add background history or external knowledge not supported by excerpts.`;
  }

  const materialNote =
    materialLang === "en"
      ? "教材片段为英文或英中混合，回答时可先保留关键英文术语，再用中文解释。"
      : "教材片段为中文，优先使用教材原词。";

  return `你是北京林业大学森林培育学科的专业教学助手，只能基于提供的教材片段回答。
${materialNote}

回答协议：
1. 先识别问题意图：${describeIntent(analysis.intent, "zh")}。
2. 如果问题是分类、方法、步骤或比较题，必须完整列出教材中明确出现的项目，不得只给总述。
3. 分类题先给“总览 + 完整清单 + 逐项说明”；方法/步骤题先给“总览 + 完整清单 + 逐项说明”；比较题先给“对比表/分点对比 + 结论”。
4. 如果教材只覆盖部分内容，要明确说明“教材只明确提到以下项目”，不要补外部知识。
5. 回答前先在内部检查一次：是否覆盖所有相关片段、是否存在漏项、是否还带有教材外补充。检查不过就重写。
6. 直接输出 Markdown，不要包裹在 JSON 或代码块中。
7. 不要出现"[引用1]"、"[citation]"、"片段[1]"等引用标记。
8. 严禁扩展教材外知识，不要凭常识或通用知识补充。`;
}

export function buildSystemPrompt(
  materialTitles: string[],
  questionLang: "zh" | "en" = "zh",
  materialLang: "zh" | "en" = "zh",
  analysis: QuestionAnalysis = detectQuestionIntent("", questionLang)
): string {
  if (questionLang === "en") {
    const titleList = materialTitles.length
      ? materialTitles.map((t) => `- ${t}`).join("\n")
      : "- (No textbook excerpts)";

    return `${buildSystemHeader(questionLang, materialLang, analysis)}

Textbooks:
${titleList}

Requirements:
1. Source only: use only the provided excerpts. Do not add outside knowledge. If not covered, reply with: "The provided textbook excerpts do not cover this topic."
2. ${analysis.conciseDefinition ? "Concise definition mode: answer only the core definition from excerpts in 2-4 sentences." : "Completeness: synthesize ALL provided excerpts thoroughly. For classification/method/step/comparison questions, list every item that appears in the excerpts."}
3. Structure: follow this blueprint: ${buildAnswerBlueprint(analysis, questionLang)}.
4. Key terms: use **bold** for key terms, important concepts, and critical conclusions. Precisely preserve numeric data, formulas, and ratios from the textbook.
5. Textbook language: preserve original terminology. If multiple viewpoints exist, list them all.
6. ${analysis.conciseDefinition ? "Format: output plain concise Markdown in 2-4 sentences; do not use long sectioned expansion." : "Format: output directly in Markdown. Start with a 1-2 sentence overview, then expand with full details."}
7. No citation markers: do not include "[引用1]", "[citation]", or any reference markers.

${analysis.conciseDefinition ? "8. This is a concise definition question. Answer in 2-4 sentences only; do not add history, classification, purpose, development, or other extensions." : ""}

${buildFewShot(questionLang, analysis)}`;
  }

  if (materialLang === "en") {
    return `${buildSystemHeader(questionLang, materialLang, analysis)}

下面是英文教材相关段落，请基于这些英文教材内容，用中文回答问题。
回答时：
1. 先给出英文教材的关键原文或关键术语（1-2句）
2. 再给出中文翻译和解释
3. 若问题属于分类/方法/步骤/比较题，必须完整列出教材中明确出现的项目，不能只给概述

规则：
- 只能基于提供的教材内容回答，不能使用教材以外的知识
- 如果教材中没有相关内容，回复"教材中未涉及此内容"
- 使用 **加粗**（Markdown格式）标记关键术语和重要概念
- 直接输出 Markdown 格式的回答，不要包裹在 JSON 或代码块中`;
  }

  const titleList = materialTitles.length
    ? materialTitles.map((t, i) => `  ${i + 1}. 《${t}》`).join("\n")
    : "  （暂无已发布教材）";

  return `${buildSystemHeader(questionLang, materialLang, analysis)}

严格基于以下教材内容回答学生问题：
${titleList}

回答要求：
1. 知识来源：只能基于提供的教材片段回答，不得使用教材外知识。如果教材未涉及该内容，明确回复"教材中未涉及此内容"。
2. ${analysis.conciseDefinition ? "简洁定义模式：仅基于教材给出定义本身，控制在2-4句，不做延伸讲解。" : "全面完整：综合所有提供的教材片段信息，给出尽可能全面、详尽的回答。对于分类、类型、方法、步骤、比较等题目，要完整列出每一项，并逐项说明。"}
3. 结构清晰：${analysis.conciseDefinition ? `直接按“定义句 + 1-2句补充说明”输出。` : `按照"定义与概述→分类/类型→具体方法/步骤→原则与注意事项→应用场景"等逻辑顺序组织。`} ${buildAnswerBlueprint(analysis, questionLang)}
4. 突出重点：使用 **加粗** 标记关键术语、重要概念和核心结论。对于教材中的数据、公式、比例等要精确引用。
5. 保留教材表述：尽量使用教材中的原始术语和表述，可以适当组织和概括，但核心信息必须来自教材。如果教材中有多个观点或说法，应完整列出。
6. 格式规范：${analysis.conciseDefinition ? "直接输出 Markdown，2-4句即可，不要使用长篇多级标题。" : "直接输出 Markdown 格式，不要包裹在 JSON 或代码块中。开头先用1-2句话概括主题，再展开详细内容。"}
7. 禁止引用标记：回答中绝对不要出现"[引用1]"、"[引用2]"等引用编号标记，也不要出现"片段[引用N]"、"[citation]"等任何形式的引用标注。直接陈述内容即可。
${analysis.conciseDefinition ? "\n8. 当前是“简洁定义题”，仅回答定义本身（2-4句），不得扩展到历史、分类、目的、发展、问题等延伸内容。" : ""}

${buildFewShot(questionLang, analysis)}`;
}

export function buildUserPrompt(
  question: string,
  chunks: SearchResult[],
  questionLang: "zh" | "en" = "zh",
  analysis: QuestionAnalysis = detectQuestionIntent(question, questionLang)
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
    return `Question intent: ${describeIntent(analysis.intent, "en")}

Question:
${question}

Answer blueprint:
${buildAnswerBlueprint(analysis, questionLang)}

Completion constraints:
- Use only the excerpts below.
- If the question asks for types, methods, steps, or comparisons, list every item explicitly mentioned in the excerpts.
- Do not stop at a summary sentence.
- If the excerpts only cover part of the topic, say so clearly.
${analysis.conciseDefinition ? "- This is a concise definition question. Use 2-4 sentences only and stop after the core definition." : ""}

Textbook excerpts (${chunks.length}):
${chunkTexts}

Please answer based on the excerpts above and keep the structure aligned with the blueprint.`;
  }

  return `【问题类型】${describeIntent(analysis.intent, "zh")}

【学生问题】
${question}

【回答蓝图】
${buildAnswerBlueprint(analysis, questionLang)}

【完整性约束】
- 只能使用下方教材片段。
- 如果是分类/方法/步骤/比较题，必须把教材中明确出现的项目全部列出。
- 不要只写概述，必须先总述再逐项展开。
- 如果教材只覆盖部分内容，要明确说明“教材只明确提到以下项目”。
${analysis.conciseDefinition ? "- 这是简洁定义题：只用2-4句话回答定义本身，禁止历史背景/分类/目的等延伸。" : ""}

【教材内容片段（共 ${chunks.length} 条）】
${chunkTexts}

${analysis.conciseDefinition
  ? "请仅基于以上片段给出2-4句定义性回答，不要展开历史、分类、目的或其他延伸。"
  : "请综合以上所有教材片段，给出全面、详尽、结构清晰的回答。不要遗漏任何片段中的相关信息。"} `;
}

const FOCUS_TERM_STOPWORDS = new Set([
  "什么",
  "哪些",
  "如何",
  "怎么",
  "怎样",
  "为什么",
  "提高",
  "方法",
  "步骤",
  "分类",
  "类型",
  "包括",
  "介绍",
  "说明",
  "解释",
  "森林",
  "培育",
  "学",
  "的",
  "了",
  "在",
  "和",
  "是",
]);

function normalizeForFocus(text: string): string {
  return text
    .toLowerCase()
    .replace(/[，。？！、；：""''（）【】《》\s]/g, "")
    .replace(/[?,;:!"'()\[\]\s]/g, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickFocusTerms(
  question: string,
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): string[] {
  const terms = [question, ...analysis.keywords]
    .map((term) => normalizeForFocus(term))
    .filter((term) => term.length >= (questionLang === "en" ? 4 : 2))
    .filter((term) => !FOCUS_TERM_STOPWORDS.has(term))
    .sort((a, b) => b.length - a.length);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    if (seen.has(term)) continue;
    seen.add(term);
    unique.push(term);
  }
  return unique.slice(0, 8);
}

function isNumericLikeChapter(chapter: string): boolean {
  const trimmed = chapter.trim();
  if (!trimmed) return false;
  if (/^(?:\d+(?:\.\d+){0,6}%?)$/.test(trimmed)) return true;
  if (/^[\d.%\-]+$/.test(trimmed) && !/[\u4e00-\u9fa5a-z]/i.test(trimmed)) return true;
  return false;
}

function looksLikeCatalogBlock(text: string): boolean {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 5) return false;

  const probe = lines.slice(0, 12);
  let shortLines = 0;
  let numberedLines = 0;
  for (const line of probe) {
    if (line.length <= 24) shortLines++;
    if (
      /^(\d+(?:\.\d+){1,6}|[一二三四五六七八九十]+[、．.)]|\(?\d+[)）.、．]|[A-Za-z][.)])/.test(line)
    ) {
      numberedLines++;
    }
  }

  return shortLines >= Math.ceil(probe.length * 0.65) && numberedLines >= 3;
}

function isNoisySearchResult(row: SearchResult): boolean {
  const chapter = (row.chapter || "").trim();
  const content = row.content.trim();
  if (!content) return true;
  if (chapter && isNumericLikeChapter(chapter)) return true;
  if (/^(复习思考题|思考题|习题|练习题|参考文献|目录)/.test(content)) return true;
  if (looksLikeCatalogBlock(content)) return true;
  return false;
}

function filterNoisySearchResults(searchResults: SearchResult[]): SearchResult[] {
  if (searchResults.length <= 1) return searchResults;
  const filtered = searchResults.filter((row) => !isNoisySearchResult(row));
  return filtered.length > 0 ? filtered : searchResults;
}

function focusResultsByChapter(
  question: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): SearchResult[] {
  if (searchResults.length <= 6) return searchResults;

  const focusTerms = pickFocusTerms(question, questionLang, analysis);
  if (focusTerms.length === 0) return searchResults;

  const sorted = [...searchResults].sort((a, b) => b.similarity - a.similarity);
  const chapterBuckets = new Map<
    string,
    {
      chapter: string;
      rows: SearchResult[];
      score: number;
      chapterHit: number;
    }
  >();

  for (const row of sorted) {
    const chapter = (row.chapter || "").trim();
    if (!chapter) continue;
    const chapterKey = normalizeForFocus(chapter);
    if (!chapterKey) continue;

    const chapterMatchCount = focusTerms.filter((term) => chapterKey.includes(term)).length;
    const contentMatchCount = focusTerms
      .slice(0, 4)
      .filter((term) => normalizeForFocus(row.content).includes(term)).length;

    const bucket = chapterBuckets.get(chapterKey) ?? {
      chapter,
      rows: [],
      score: 0,
      chapterHit: 0,
    };

    bucket.rows.push(row);
    bucket.score += row.similarity * 2.6 + chapterMatchCount * 2.2 + contentMatchCount * 0.7;
    if (chapterMatchCount > 0) bucket.chapterHit += 1;

    chapterBuckets.set(chapterKey, bucket);
  }

  if (chapterBuckets.size === 0) return sorted;

  const rankedBuckets = Array.from(chapterBuckets.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length;
    return b.chapterHit - a.chapterHit;
  });

  const best = rankedBuckets[0];
  const second = rankedBuckets[1];
  const dominance = second ? best.score / Math.max(second.score, 0.0001) : 10;
  const coverageRatio = best.rows.length / sorted.length;
  const hasStrongChapterSignal = best.chapterHit >= 2;

  const shouldFocus =
    (coverageRatio >= 0.4 && dominance >= 1.1) ||
    (hasStrongChapterSignal && best.rows.length >= 3 && dominance >= 1.05);

  if (!shouldFocus) return sorted;

  const keepTarget = Math.max(4, Math.min(sorted.length, pickTopK(questionLang, analysis)));
  const focused = best.rows
    .slice()
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, keepTarget);

  if (focused.length >= Math.min(4, sorted.length)) return focused;

  const pickedIds = new Set(focused.map((row) => row.chunkId));
  for (const row of sorted) {
    if (pickedIds.has(row.chunkId)) continue;
    focused.push(row);
    pickedIds.add(row.chunkId);
    if (focused.length >= keepTarget) break;
  }

  return focused;
}

function pickSourceLimit(questionLang: "zh" | "en", analysis: QuestionAnalysis): number {
  if (analysis.conciseDefinition) return 2;
  if (analysis.conciseEntity) return 2;
  if (analysis.conciseAnswer) return 3;
  if (analysis.intent === "definition") return questionLang === "en" ? 4 : 5;
  if (analysis.requestDetail) return questionLang === "en" ? 8 : 9;
  if (analysis.expectsFullCoverage) return questionLang === "en" ? 6 : 7;
  return questionLang === "en" ? 5 : 6;
}

function pickTopK(questionLang: "zh" | "en", analysis: QuestionAnalysis, forAuxEnglish = false): number {
  if (analysis.conciseDefinition) {
    if (questionLang === "en") return forAuxEnglish ? 1 : 3;
    return forAuxEnglish ? 2 : 4;
  }
  if (analysis.conciseEntity) {
    if (questionLang === "en") return forAuxEnglish ? 1 : 2;
    return forAuxEnglish ? 2 : 3;
  }
  if (analysis.conciseAnswer) {
    if (questionLang === "en") return forAuxEnglish ? 1 : 3;
    return forAuxEnglish ? 2 : 4;
  }
  if (analysis.intent === "definition") return questionLang === "en" ? 5 : 8;
  if (analysis.expectsFullCoverage) {
    if (analysis.requestDetail) return questionLang === "en" ? 10 : 14;
    return questionLang === "en" ? 7 : 10;
  }
  return questionLang === "en" ? 6 : 8;
}

export async function generateAnswer(req: QARequest): Promise<QAResponse> {
  const startTime = Date.now();
  const questionLanguage = detectLanguage(req.question);
  const questionAnalysis = detectQuestionIntent(req.question, questionLanguage);

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
      const enResults = await semanticSearch(req.question, undefined, pickTopK("en", questionAnalysis), "en", useRAG);
      mainResult = await callLLM(req.question, enResults, "en", "en", questionAnalysis);
    } else {
      const [zhResults, enResults] = await Promise.all([
        semanticSearch(req.question, undefined, pickTopK("zh", questionAnalysis), "zh", useRAG),
        semanticSearch(req.question, undefined, pickTopK("en", questionAnalysis, true), "en", useRAG),
      ]);

      mainResult = await callLLM(req.question, zhResults, "zh", "zh", questionAnalysis);

      if (enResults.length > 0) {
        const enResult = await callLLM(req.question, enResults, "zh", "en", questionAnalysis);
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
  materialLang: "zh" | "en",
  analysis: QuestionAnalysis = detectQuestionIntent(question, questionLang)
): Promise<CallLLMResult> {
  const cleanedResults = filterNoisySearchResults(searchResults);
  if (cleanedResults.length === 0) {
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

  const keywords = questionLang === "en" ? extractKeywordsEn(question) : extractKeywords(question);
  let effectiveResults = analysis.conciseDefinition
    ? [...cleanedResults]
    : focusResultsByChapter(question, cleanedResults, questionLang, analysis);
  if (analysis.conciseDefinition) {
    effectiveResults = await enrichDefinitionResults(question, effectiveResults, questionLang, analysis);
    effectiveResults = filterNoisySearchResults(effectiveResults);
    const definitionTargets = pickDefinitionTargets(question, keywords, questionLang);
    if (definitionTargets.length > 0) {
      const targeted = effectiveResults.filter((row) => {
        const text = `${row.chapter || ""}\n${row.content}`.toLowerCase();
        return definitionTargets.some((term) => text.includes(term));
      });
      if (targeted.length > 0) {
        effectiveResults = targeted;
      }
    }
  }
  const sourceLimit = pickSourceLimit(questionLang, analysis);
  const materialTitles = Array.from(new Set(effectiveResults.map((r) => r.materialTitle)));
  const extractive = analysis.conciseAnswer
    ? buildExtractiveAnswer(question, effectiveResults, questionLang, analysis)
    : null;
  if (analysis.conciseDefinition && !extractive) {
    const fallbackAnswer = await generateClosestDefinitionFromExcerpts(
      question,
      effectiveResults,
      questionLang,
      materialLang,
      analysis
    );
    const answer = fallbackAnswer || (questionLang === "en"
      ? "The provided excerpts do not contain a direct definition sentence for this term."
      : "教材片段中未检索到该术语的直接定义句（如“是指/定义为”）。请尝试补充更具体术语后再问。");
    return {
      answer,
      sources: buildSources(effectiveResults, Boolean(fallbackAnswer), keywords, sourceLimit),
      modelUsed: "definition-synth",
      foundInMaterials: Boolean(fallbackAnswer),
      confidence: fallbackAnswer ? 0.72 : 0.2,
    };
  }
  if (extractive) {
    const conciseResults = effectiveResults.filter((r) => extractive.usedChunkIds.includes(r.chunkId));
    const sources = buildSources(conciseResults, true, keywords, sourceLimit);
    const strictDefinition = extractive.strictDefinition !== false;
    const extractiveModel = analysis.conciseDefinition && !strictDefinition ? "extractive-approx" : "extractive";
    const extractiveConfidence = analysis.conciseDefinition
      ? (strictDefinition ? 0.9 : 0.74)
      : 0.9;
    return {
      answer: extractive.answer,
      sources,
      modelUsed: extractiveModel,
      foundInMaterials: true,
      confidence: extractiveConfidence,
    };
  }

  const systemPrompt = buildSystemPrompt(materialTitles, questionLang, materialLang, analysis);
  const userMessage = buildUserPrompt(question, effectiveResults, questionLang, analysis);

  const llmResponse = await invokeLLMWithConfig(
    [{ role: "user", content: userMessage }],
    systemPrompt,
    {
      temperature: analysis.conciseAnswer ? 0 : undefined,
      maxTokens: analysis.conciseAnswer ? 420 : undefined,
    }
  );

  let answer = stripCitationMarkers(llmResponse.content);

  // 如果 LLM 仍然返回了 JSON，提取 answer 字段
  const parsed = parseLLMOutput(llmResponse.content);
  if (parsed) {
    answer = stripCitationMarkers(parsed.answer);
  }

  if (analysis.conciseAnswer) {
    answer = enforceConciseDefinition(answer, questionLang);
  }

  const localReview = assessAnswerLocally(answer, effectiveResults, analysis, questionLang);
  let review = localReview;

  if (!analysis.conciseAnswer && !localReview.complete) {
    try {
      const reviewResponse = await invokeLLMWithConfig(
        [{ role: "user", content: buildAnswerReviewPrompt(question, answer, effectiveResults, questionLang, analysis) }],
        questionLang === "en"
          ? "You are a strict answer reviewer. Return JSON only."
          : "你是严格的答案审校器，只返回 JSON。", 
        { responseFormat: "json_object", temperature: 0 }
      );

      const parsedReview = parseAnswerReview(reviewResponse.content);
      if (parsedReview) {
        review = parsedReview;
      }
    } catch {
      // JSON 审校失败时回退到本地规则
    }
  }

  if (!analysis.conciseAnswer && review.shouldRetry) {
    try {
      const revisionResponse = await invokeLLMWithConfig(
        [{ role: "user", content: buildRevisionPrompt(question, answer, effectiveResults, questionLang, analysis, review.issues) }],
        buildSystemPrompt(materialTitles, questionLang, materialLang, analysis)
      );
      const revisionParsed = parseLLMOutput(revisionResponse.content);
      answer = stripCitationMarkers(revisionParsed ? revisionParsed.answer : revisionResponse.content);
    } catch {
      // 重写失败时保留原答案
    }
  }

  const finalReview = assessAnswerLocally(answer, effectiveResults, analysis, questionLang);
  const grounding = assessGrounding(answer, effectiveResults, questionLang);
  if (!grounding.grounded) {
    try {
      const groundedRewrite = await invokeLLMWithConfig(
        [{ role: "user", content: buildGroundedRewritePrompt(question, effectiveResults, questionLang, analysis) }],
        questionLang === "en"
          ? "You are a strict extractive tutor. Use only the provided excerpts."
          : "你是严格的教材抽取式助手，只能使用给定片段原意回答。",
        { temperature: 0, maxTokens: analysis.conciseAnswer ? 320 : 1200 }
      );
      answer = stripCitationMarkers(groundedRewrite.content);
      if (analysis.conciseAnswer) {
        answer = enforceConciseDefinition(answer, questionLang);
      }
    } catch {
      // fallback to existing answer
    }
  }
  if (!finalReview.complete) {
    answer = appendDegradationNote(answer, finalReview.downgradeNote);
  }

  // 判断是否在教材中找到了内容
  const notFoundPhrases = ["未涉及", "not cover", "没有相关", "未找到", "not found"];
  const foundInMaterials = !notFoundPhrases.some((p) => answer.toLowerCase().includes(p));

  const sources = buildSources(effectiveResults, foundInMaterials, keywords, sourceLimit);

  const confidence = finalReview.complete ? 0.82 : review.shouldRetry ? 0.58 : 0.68;

  return {
    answer,
    sources,
    modelUsed: llmResponse.model,
    foundInMaterials,
    confidence: foundInMaterials ? confidence : 0.1,
  };
}

/** 清除 LLM 回答中残留的 citation 标记 */
function stripCitationMarkers(text: string): string {
  const withoutCitation = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\[citation_indices?:\s*[\d,\s]+\]/gi, "")
    .replace(/\[引用\d+\]/g, "")
    .replace(/【?片段\d+】?/g, "")
    .replace(/片段\[?\d+\]?至?\[?\d*\]?/g, "");

  return normalizeMarkdownSpacing(withoutCitation);
}

function normalizeMarkdownSpacing(text: string): string {
  const blockStartPattern = /([^\n#])(?:[ \t]*)(#{1,6}\s+|>\s+|[-*+]\s+|\d{1,3}[.)、．]\s+)/g;
  const leadingBlockPattern = /^\s*(#{1,6}\s+|>\s+|[-*+]\s+|\d{1,3}[.)、．]\s+)/gm;
  return text
    .replace(blockStartPattern, "$1\n\n$2")
    .replace(leadingBlockPattern, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
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

function countStructuredItems(answer: string): number {
  return answer
    .split(/\n+/)
    .filter((line) => /^\s*(\d+[.)、．]|[一二三四五六七八九十]+[、．.)]|[-*•])\s+/.test(line) || /^#{1,6}\s+/.test(line))
    .length;
}

function assessAnswerLocally(
  answer: string,
  searchResults: SearchResult[],
  analysis: QuestionAnalysis,
  questionLang: "zh" | "en"
): AnswerReview {
  const compactAnswer = answer.replace(/\s+/g, "");
  const itemCount = countStructuredItems(answer);
  const hasNotFoundPhrase = /未涉及|没有相关|未找到|not cover|not found/i.test(answer);
  const hasCoveragePhrase = /共\d+|共有\d+|明确提到|完整列出|逐项|包括|分为|可分为|types?|methods?|steps?/i.test(answer);
  const hasCompareStructure = /\|.+\|/m.test(answer) || /对比|比较|difference|compare/i.test(answer);
  const issues: string[] = [];

  if (analysis.conciseAnswer && compactAnswer.length > 300) {
    issues.push("简洁回答模式下答案过长，出现不必要延伸");
  }

  if (analysis.expectsFullCoverage && compactAnswer.length < 120) {
    issues.push("回答过短，可能未覆盖完整要点");
  }

  if (analysis.intent === "definition" && !/(定义|含义|概念|是指|指的是|meaning|definition|concept)/i.test(answer)) {
    issues.push("定义题缺少明确的定义表达");
  }

  if (analysis.expectsEnumeration && itemCount < 2) {
    issues.push("分类/方法题的结构化条目过少");
  }

  if (analysis.intent === "comparison" && !hasCompareStructure) {
    issues.push("比较题缺少对比表或分点对比");
  }

  if (analysis.expectsFullCoverage && !hasCoveragePhrase) {
    issues.push("缺少完整性提示或清单式表达");
  }

  if (searchResults.length > 0 && hasNotFoundPhrase && !/教材只明确提到|部分内容|partial/i.test(answer)) {
    issues.push("存在召回片段，但回答仍表现为未涉及");
  }

  const complete = issues.length === 0;
  const downgradeNote =
    questionLang === "en"
      ? "The excerpts only cover part of the topic, so this answer summarizes the explicitly mentioned items only."
      : "教材片段只覆盖了该问题的部分要点，以下仅整理已明确出现的内容。";

  return {
    complete,
    issues,
    shouldRetry: !analysis.conciseAnswer && !complete && searchResults.length > 0,
    downgradeNote,
  };
}

function parseAnswerReview(content: string): AnswerReview | null {
  try {
    const parsed = JSON.parse(content.trim());
    if (isValidAnswerReview(parsed)) return parsed;
  } catch {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        if (isValidAnswerReview(parsed)) return parsed;
      } catch {
        // noop
      }
    }
  }
  return null;
}

function isValidAnswerReview(obj: unknown): obj is AnswerReview {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.complete === "boolean" &&
    Array.isArray(o.issues) &&
    typeof o.shouldRetry === "boolean" &&
    typeof o.downgradeNote === "string"
  );
}

function buildAnswerReviewPrompt(
  question: string,
  answer: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): string {
  const sourceTexts = searchResults
    .map((r, idx) => {
      const location = [
        `《${r.materialTitle}》`,
        r.chapter ? r.chapter : null,
        r.pageStart ? `第${r.pageStart}页${r.pageEnd && r.pageEnd !== r.pageStart ? `~${r.pageEnd}页` : ""}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      return `【片段${idx + 1}】${location}\n${r.content.substring(0, 260)}`;
    })
    .join("\n\n---\n\n");

  if (questionLang === "en") {
    return `You are reviewing an answer for completeness.
Question intent: ${describeIntent(analysis.intent, "en")}
Question: ${question}

Answer:
${answer}

Textbook excerpts:
${sourceTexts}

Return JSON with:
{"complete": boolean, "issues": string[], "shouldRetry": boolean, "downgradeNote": string}

Rules:
- complete=true only when the answer fully covers the items explicitly present in the excerpts.
- shouldRetry=true when the answer is too short, misses list items, or collapses a list question into a summary.
- downgradeNote should explain the limitation in one sentence.`;
  }

  return `你是答案审校器，只判断当前答案是否完整，不要改写答案。
问题意图：${describeIntent(analysis.intent, "zh")}
学生问题：${question}

当前答案：
${answer}

教材片段：
${sourceTexts}

请只返回 JSON，格式如下：
{"complete": true/false, "issues": ["问题1", "问题2"], "shouldRetry": true/false, "downgradeNote": "一句话说明"}

规则：
- complete=true 仅当答案完整覆盖了教材片段中明确出现的项目。
- 如果答案把分类/方法/步骤题写成了概述，shouldRetry 要设为 true。
- downgradeNote 用一句话说明教材片段覆盖范围有限时应如何表述。`;
}

function buildRevisionPrompt(
  question: string,
  answer: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis,
  issues: string[]
): string {
  const sourceTexts = searchResults
    .map((r, idx) => {
      const location = [
        `《${r.materialTitle}》`,
        r.chapter ? r.chapter : null,
        r.pageStart ? `第${r.pageStart}页${r.pageEnd && r.pageEnd !== r.pageStart ? `~${r.pageEnd}页` : ""}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      return `【片段${idx + 1}】${location}\n${r.content}`;
    })
    .join("\n\n---\n\n");

  if (questionLang === "en") {
    return `Rewrite the answer to be complete and strictly grounded in the excerpts.
Question intent: ${describeIntent(analysis.intent, "en")}
Question: ${question}

Review issues:
- ${issues.join("\n- ")}

Previous answer:
${answer}

Textbook excerpts:
${sourceTexts}

Requirements:
1. Keep the final answer in Markdown.
2. Do not mention the review process.
3. For classification/method/step/comparison questions, enumerate every item explicitly mentioned in the excerpts.
4. If the excerpts only cover part of the topic, say so clearly.`;
  }

  return `请重写答案，补全遗漏项，并且只使用教材片段中明确出现的内容。
问题意图：${describeIntent(analysis.intent, "zh")}
学生问题：${question}

审校发现的问题：
- ${issues.join("\n- ")}

原始答案：
${answer}

教材片段：
${sourceTexts}

要求：
1. 最终答案必须是 Markdown。
2. 不要提及审校过程。
3. 如果是分类/方法/步骤/比较题，必须把教材中明确出现的项目全部列出。
4. 如果教材只覆盖部分内容，明确说明限制。`;
}

function appendDegradationNote(answer: string, note: string): string {
  if (answer.includes(note)) return answer;
  return `${answer}\n\n> ${note}`;
}

function buildSources(
  searchResults: SearchResult[],
  foundInMaterials: boolean,
  keywords: string[],
  maxSources: number
): QuerySource[] {
  if (!foundInMaterials || maxSources <= 0) return [];

  const selected = searchResults.slice(0, Math.max(1, maxSources * 2));
  const deduped: QuerySource[] = [];
  const seen = new Set<string>();

  for (const row of selected) {
    const dedupeKey = [
      row.materialId,
      row.chunkIndex,
      row.chapter || "",
      row.pageStart ?? -1,
      row.pageEnd ?? -1,
    ].join("|");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    deduped.push({
      materialId: row.materialId,
      materialTitle: row.materialTitle,
      chapter: row.chapter,
      pageStart: row.pageStart,
      pageEnd: row.pageEnd,
      excerpt: row.content.substring(0, 200) + (row.content.length > 200 ? "..." : ""),
      highlightedExcerpt: extractHighlightSentence(row.content, keywords),
    });

    if (deduped.length >= maxSources) break;
  }

  return deduped;
}

function enforceConciseDefinition(answer: string, questionLang: "zh" | "en"): string {
  const plain = answer
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*\d+[.)、．]\s+/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const sentences = questionLang === "en"
    ? plain.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
    : plain.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);
  const kept = sentences.slice(0, 4);
  let concise = kept.join(questionLang === "en" ? " " : "");
  if (!concise) concise = plain.slice(0, 220);
  const maxLen = questionLang === "en" ? 520 : 260;
  if (concise.length > maxLen) {
    concise = concise.slice(0, maxLen).trim();
    if (questionLang === "zh" && !/[。！？]$/.test(concise)) concise += "。";
    if (questionLang === "en" && !/[.!?]$/.test(concise)) concise += ".";
  }
  return concise;
}

function assessGrounding(
  answer: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en"
): { grounded: boolean; score: number } {
  if (searchResults.length === 0) return { grounded: true, score: 1 };
  const sourceText = searchResults.map((s) => s.content).join("\n").toLowerCase();
  const keywords = (questionLang === "en" ? extractKeywordsEn(answer) : extractKeywords(answer))
    .filter((k) => k.length >= 2)
    .slice(0, 20);
  if (keywords.length === 0) return { grounded: true, score: 1 };
  let hit = 0;
  for (const kw of keywords) {
    if (sourceText.includes(kw.toLowerCase())) hit++;
  }
  const score = hit / keywords.length;
  return { grounded: score >= 0.55, score };
}

function buildGroundedRewritePrompt(
  question: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): string {
  const sourceTexts = searchResults
    .slice(0, analysis.conciseDefinition ? 4 : searchResults.length)
    .map((r, idx) => `【片段${idx + 1}】${r.content}`)
    .join("\n\n");
  if (questionLang === "en") {
    return `Rewrite the answer using only information that appears in the excerpts below.
Question: ${question}
Rules:
1. No external knowledge.
2. Paraphrase conservatively; do not add new facts.
3. ${analysis.conciseDefinition ? "Answer in 2-4 sentences only." : "Keep a clear structure based on the question intent."}

Excerpts:
${sourceTexts}`;
  }
  return `请仅基于下方片段重写答案，不得加入片段以外事实。
学生问题：${question}
要求：
1. 只能使用片段中出现的信息，不得发挥。
2. 可适度改写表述，但不能新增事实。
3. ${analysis.conciseDefinition ? "这是简洁定义题，仅用2-4句。禁止历史背景和延伸。" : "按问题类型组织结构，但不要超出片段。"}

教材片段：
${sourceTexts}`;
}

const ZH_DEFINITION_STOP_WORDS = new Set([
  "什么",
  "什么是",
  "如何",
  "怎么",
  "怎样",
  "请问",
  "定义",
  "含义",
  "概念",
  "解释",
  "说明",
  "森林",
  "培育",
  "学",
  "的",
  "了",
  "是",
]);

function hasDefinitionCue(text: string, questionLang: "zh" | "en"): boolean {
  if (questionLang === "en") {
    return /\b(is|means|refers to|defined as|definition|concept)\b/i.test(text);
  }
  return /(是指|指的是|定义为|定义是|含义是|是研究|是一门|是.*?学科|概念是|概念指|是从)/.test(text);
}

function hasHistoricalCue(text: string, questionLang: "zh" | "en"): boolean {
  if (questionLang === "en") {
    return /\b(history|historical|century|in \d{4}|during)\b/i.test(text);
  }
  return /(历史|发展|20世纪|年代|文革|出版|编写|奠基|繁荣)/.test(text);
}

function isDefinitionBoilerplateSentence(text: string, questionLang: "zh" | "en"): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const compact = normalizeForFocus(trimmed);
  if (/^(复习思考题|思考题|习题|练习题|目录|参考文献)/.test(trimmed)) return true;
  if (/^\d+(?:\.\d+){1,6}\s*$/.test(trimmed)) return true;
  if (/(在此再次|通过介绍|变化渊源|名词及其内涵|下文将|如下所述|本书将|本章将)/.test(trimmed)) return true;
  if (/既然是涉及.*全过程.*学科/.test(trimmed)) return true;
  if (
    /由于前一时期用词混乱|用词混乱造成|有关名词及其内涵|变化渊源作一简单介绍|通过介绍也可/.test(compact)
  ) {
    return true;
  }

  if (questionLang === "en") {
    return /^(chapter|section)\s+\d+/i.test(trimmed);
  }

  if (/^(第[一二三四五六七八九十百零\d]+[章节篇部编]|[\d]+(?:\.[\d]+){1,6})/.test(trimmed) && trimmed.length <= 24) {
    return true;
  }

  return /^(本章|本节|本部分|教材)(重点|主要|将|阐述|介绍|说明)/.test(trimmed);
}

function pickDefinitionTargets(question: string, keywords: string[], questionLang: "zh" | "en"): string[] {
  const cleanedQuestion = questionLang === "en"
    ? question.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim()
    : question
        .replace(/[，。？！、；：""''（）【】《》\s]+/g, "")
        .replace(/什么是|定义|含义|概念|解释|说明|请问|如何|怎么|怎样/g, "")
        .trim();

  const candidates = [cleanedQuestion, ...keywords]
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length >= (questionLang === "en" ? 4 : 2))
    .filter((term) =>
      questionLang === "en" ? true : !ZH_DEFINITION_STOP_WORDS.has(term)
    )
    .sort((a, b) => b.length - a.length);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const term of candidates) {
    if (!term || seen.has(term)) continue;
    seen.add(term);
    unique.push(term);
  }

  const primary = cleanedQuestion.trim().toLowerCase();
  if (!primary) return unique.slice(0, 4);

  if (questionLang === "zh" && primary.length >= 4) {
    const narrowed = unique.filter((term) => {
      if (term === primary) return true;
      // 避免“造林时间”被“造林”等短词稀释，导致定义题跑偏。
      if (primary.includes(term) && term.length <= primary.length - 1) return false;
      return true;
    });
    const ordered = [primary, ...narrowed.filter((term) => term !== primary)];
    return ordered.slice(0, 4);
  }

  if (questionLang === "en" && primary.split(/\s+/).length >= 2) {
    const narrowed = unique.filter((term) => term === primary || term.length >= 4);
    const ordered = [primary, ...narrowed.filter((term) => term !== primary)];
    return ordered.slice(0, 4);
  }

  return unique.slice(0, 4);
}

function prioritizeDefinitionResults(
  question: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  keywords: string[]
): SearchResult[] {
  if (searchResults.length <= 4) return searchResults;

  const targets = pickDefinitionTargets(question, keywords, questionLang);
  if (targets.length === 0) return searchResults;

  const ranked = searchResults
    .map((row) => {
      const text = `${row.chapter || ""}\n${row.content}`;
      const chapterText = row.chapter || "";
      const lowerText = text.toLowerCase();
      const targetHits = targets.filter((term) => text.toLowerCase().includes(term)).length;
      const cue = hasDefinitionCue(row.content, questionLang) ? 1 : 0;
      const directDefinitionHit = targets.some((term) => {
        const escaped = escapeRegExp(term);
        if (questionLang === "en") {
          return new RegExp(`\\b${escaped}\\b.{0,20}\\b(is|means|refers to|defined as)\\b`, "i").test(lowerText);
        }
        const prefix = term.endsWith("学") ? escaped : `${escaped}(?!学)`;
        return new RegExp(`${prefix}.{0,8}(是指|指的是|定义为|定义是|是研究|是一门|是.*?学科)`).test(text);
      });
      const chapterDefinitionCue = questionLang === "en"
        ? /\b(definition|concept|meaning|overview)\b/i.test(chapterText)
        : /(概念|定义|含义|范畴|总论|概述)/.test(chapterText);
      const history = hasHistoricalCue(text, questionLang) ? 1 : 0;
      const contextualPenalty = questionLang === "en"
        ? cue === 0 && /(should|need to|management|operation|practice|treatment|during)/i.test(row.content) ? 1.4 : 0
        : cue === 0 && /(应|需|需要|可|可以|采用|实施|管理|措施|技术|作业|阶段|条件|处理)/.test(row.content) ? 1.4 : 0;
      const weakDefinitionPenalty = cue === 0 && targetHits > 0 ? 1.1 : 0;
      const score =
        row.similarity * 2.5 +
        targetHits * 2.6 +
        cue * 3.8 +
        (directDefinitionHit ? 4.6 : 0) +
        (chapterDefinitionCue ? 1.6 : 0) -
        history * 1.8 -
        contextualPenalty -
        weakDefinitionPenalty;
      return { row, score, cue, targetHits };
    })
    .sort((a, b) => b.score - a.score);

  const strong = ranked.filter((item) => item.cue > 0 && item.targetHits > 0);
  if (strong.length > 0) {
    const focused = strong.slice(0, Math.min(6, searchResults.length)).map((item) => item.row);
    const picked = new Set(focused.map((row) => row.chunkId));
    for (const item of ranked) {
      if (picked.has(item.row.chunkId)) continue;
      focused.push(item.row);
      picked.add(item.row.chunkId);
      if (focused.length >= Math.min(8, searchResults.length)) break;
    }
    return focused;
  }

  return ranked.slice(0, Math.min(8, ranked.length)).map((item) => item.row);
}

function truncateSentenceSmart(
  sentence: string,
  questionLang: "zh" | "en",
  maxLen: number
): string {
  if (sentence.length <= maxLen) return sentence.trim();

  const cut = sentence.slice(0, maxLen).trim();
  const boundaryChars = questionLang === "en"
    ? [".", "!", "?", ";", ","]
    : ["。", "！", "？", "；", "，"];

  let boundaryPos = -1;
  for (const ch of boundaryChars) {
    const idx = cut.lastIndexOf(ch);
    if (idx > boundaryPos) boundaryPos = idx;
  }

  if (boundaryPos >= Math.floor(maxLen * 0.55)) {
    return cut.slice(0, boundaryPos + 1).trim();
  }
  return `${cut}...`;
}

function extractDefinitionSubject(question: string, questionLang: "zh" | "en"): string {
  if (questionLang === "en") {
    return question
      .toLowerCase()
      .replace(/what is|define|definition|meaning|concept|explain|please/gi, " ")
      .replace(/[^a-z0-9\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 6)
      .join(" ");
  }

  return question
    .replace(/[，。？！、；：""''（）【】《》\s]+/g, "")
    .replace(/[?,;:!"'()\[\]\s]+/g, "")
    .replace(/什么是|请问|定义|含义|概念|解释|说明|何谓|是指/g, "")
    .slice(0, 24)
    .trim();
}

async function enrichDefinitionResults(
  question: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): Promise<SearchResult[]> {
  if (!analysis.conciseDefinition || searchResults.length === 0) return searchResults;

  const subject = extractDefinitionSubject(question, questionLang);
  if (!subject) return searchResults;

  const expandedQuery =
    questionLang === "en"
      ? `${subject} definition concept refers to discipline means`
      : `${subject} 定义 概念 是指 是研究 学科 含义`;

  try {
    const extraResults = await semanticSearch(
      expandedQuery,
      undefined,
      Math.max(18, pickTopK(questionLang, analysis) + 10),
      questionLang,
      false
    );
    if (extraResults.length === 0) return searchResults;

    const merged = [...extraResults, ...searchResults];
    const unique: SearchResult[] = [];
    const seen = new Set<number>();
    for (const row of merged) {
      if (seen.has(row.chunkId)) continue;
      seen.add(row.chunkId);
      unique.push(row);
    }

    const targetPoolSize = Math.max(searchResults.length + 8, pickTopK(questionLang, analysis) + 10, 14);
    return unique.slice(0, targetPoolSize);
  } catch {
    return searchResults;
  }
}

function buildExtractiveAnswer(
  question: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): { answer: string; usedChunkIds: number[]; strictDefinition?: boolean } | null {
  const queryNorm = normalizeQuestion(question);
  const keywords = (questionLang === "en" ? extractKeywordsEn(question) : extractKeywords(question))
    .filter((k) => k.length >= 2)
    .slice(0, 8);
  const definitionTargets = analysis.conciseDefinition
    ? pickDefinitionTargets(question, keywords, questionLang)
    : [];
  const definitionSubject = analysis.conciseDefinition
    ? extractDefinitionSubject(question, questionLang).toLowerCase()
    : "";
  const conciseEntityTarget = analysis.conciseEntity
    ? normalizeQuestion(
        questionLang === "en"
          ? question.replace(/\b(who|what|is|are|was|were|about|tell me)\b/gi, " ")
          : question.replace(/什么是|请问|介绍|说明|解释|是谁|谁是/g, " ")
      )
    : "";
  const effectiveResults = analysis.conciseDefinition
    ? prioritizeDefinitionResults(question, searchResults, questionLang, keywords)
    : searchResults;

  const scored: Array<{
    sentence: string;
    score: number;
    chunkId: number;
    targetHit: boolean;
    cueHit: boolean;
    definitionalHit: boolean;
  }> = [];
  const sanitizeSentence = (sentence: string): string =>
    sentence
      .replace(/【[^】]{0,80}】/g, " ")
      .replace(/\[[^\]]{0,80}\]/g, " ")
      .replace(/[【】]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const isNoisySentence = (sentence: string): boolean => {
    const s = sentence.trim();
    if (!s) return true;
    if (/^(复习思考题|思考题|习题|参考文献)/.test(s)) return true;
    if (/^\d+[.)、．]\s*$/.test(s)) return true;
    if (/^[一二三四五六七八九十]+[、．.]\s*$/.test(s)) return true;
    const clean = sanitizeSentence(s);
    if (clean.length < (questionLang === "en" ? 12 : 6)) return true;
    if (questionLang === "zh" && !/[\u4e00-\u9fa5]/.test(clean)) return true;
    return false;
  };

  const sentenceSplitter = questionLang === "en" ? /[.!?\n]/ : /[。！？\n]/;
  for (const chunk of effectiveResults.slice(0, Math.max(4, pickTopK(questionLang, analysis)))) {
    const sentences = chunk.content
      .split(sentenceSplitter)
      .map((s) => sanitizeSentence(s))
      .filter((s) => !isNoisySentence(s))
      .filter((s) => s.length >= (questionLang === "en" ? 20 : 8));

    for (const sentence of sentences) {
      const sNorm = normalizeQuestion(sentence);
      if (analysis.conciseEntity && conciseEntityTarget && !sNorm.includes(conciseEntityTarget)) {
        continue;
      }
      let score = 0;
      if (queryNorm && sNorm.includes(queryNorm)) score += 8;
      for (const kw of keywords) {
        if (sNorm.includes(normalizeQuestion(kw))) score += Math.min(4, kw.length);
      }
      if (analysis.conciseDefinition) {
        if (isDefinitionBoilerplateSentence(sentence, questionLang)) continue;
        const sentenceLower = sentence.toLowerCase();
        const targetHit = definitionTargets.some((term) => sentenceLower.includes(term));
        if (definitionTargets.length > 0 && !targetHit) continue;
        const isGenericSilvicultureDefinition = questionLang === "zh" &&
          /森林培育是从林木种子、苗木、造林更新到林木成林、成熟/.test(sentence) &&
          !/(森林培育学?|森林培育)/.test(definitionSubject);
        const isGenericSilvicultureDiscipline = questionLang === "zh" &&
          /森林培育学是研究森林培育/.test(sentence) &&
          !/森林培育学/.test(definitionSubject);
        if (isGenericSilvicultureDefinition || isGenericSilvicultureDiscipline) {
          continue;
        }
        const firstTargetPos = definitionTargets.reduce((minPos, term) => {
          const idx = sentenceLower.indexOf(term);
          if (idx < 0) return minPos;
          return Math.min(minPos, idx);
        }, Number.POSITIVE_INFINITY);
        const targetAppearsLate = Number.isFinite(firstTargetPos) && firstTargetPos > (questionLang === "en" ? 44 : 24);
        const startsWithTarget = definitionTargets.some((term) =>
          questionLang === "zh" && !term.endsWith("学")
            ? sentenceLower.startsWith(term) && !sentenceLower.startsWith(`${term}学`)
            : sentenceLower.startsWith(term)
        );
        const subjectSuffixMismatch = questionLang === "zh" &&
          Boolean(definitionSubject) &&
          !definitionSubject.endsWith("学") &&
          sentenceLower.startsWith(`${definitionSubject}学`);
        const directSubjectDefinition = definitionTargets.some((term) => {
          const escaped = escapeRegExp(term);
          if (questionLang === "en") {
            return new RegExp(`\\b${escaped}\\b.{0,20}\\b(is|means|refers to|defined as)\\b`, "i").test(sentenceLower);
          }
          const prefix = term.endsWith("学") ? escaped : `${escaped}(?!学)`;
          return new RegExp(`^${prefix}.{0,8}(是指|指的是|定义为|定义是|是研究|是一门|是.*?学科)`).test(sentence);
        });
        const cueHit = hasDefinitionCue(sentence, questionLang);
        const definitionalHit = questionLang === "en"
          ? /\b(is|means|refers to|defined as)\b/i.test(sentence)
          : /(?:^|，|。)\s*(?:[^。！？\n]{0,14})(?:是指|指的是|定义为|定义是|是研究|是一种|是一类|是将|是对|是按|是从)/.test(sentence);
        const contextualSentence = questionLang === "en"
          ? !cueHit && !definitionalHit && /(should|need to|management|operation|practice|during|under)/i.test(sentence)
          : !cueHit && !definitionalHit && /(一般|通常|应|需|需要|可|可以|采用|实施|管理|措施|技术|作业|过程|在.*时|对.+?时)/.test(sentence);
        const enumerativeDefinitionLike = questionLang === "en"
          ? /(includes|consists of|types? include|can be divided into)/i.test(sentence)
          : /(有.+(种|类|方式|类型)|包括|分为|可分为|由.+组成)/.test(sentence);
        if (targetHit) score += 6;
        if (startsWithTarget) score += 3.4;
        if (directSubjectDefinition) score += 5.4;
        if (cueHit) score += 7;
        if (definitionalHit) score += 5;
        if (targetHit && cueHit) score += 8;
        if (enumerativeDefinitionLike) score += 1.6;
        if (contextualSentence) score -= 4.5;
        if (targetAppearsLate) score -= 5.2;
        if (subjectSuffixMismatch) score -= 4.8;
        if (questionLang === "zh" && sentence.length > 120) score -= 2.2;
        if (questionLang === "zh" && sentence.length > 170) score -= 2.8;
        if (questionLang === "en" && sentence.length > 260) score -= 2.2;
        if (questionLang === "en" && sentence.length > 340) score -= 2.8;
        if (hasHistoricalCue(sentence, questionLang)) score -= 4;
        if (!targetHit && !cueHit) score -= 2;
        if (score > 0) {
          scored.push({ sentence, score, chunkId: chunk.chunkId, targetHit, cueHit, definitionalHit });
        }
        continue;
      }
      if (score > 0) {
        scored.push({
          sentence,
          score,
          chunkId: chunk.chunkId,
          targetHit: false,
          cueHit: false,
          definitionalHit: false,
        });
      }
    }
  }

  if (scored.length === 0) return null;

  if (analysis.conciseDefinition) {
    const hasStrongDefinitionSentence = scored.some((item) => item.targetHit && (item.cueHit || item.definitionalHit));
    if (!hasStrongDefinitionSentence) {
      const hasApproxDefinitionSignal = scored.some((item) => item.targetHit || item.cueHit || item.definitionalHit);
      if (!hasApproxDefinitionSignal) return null;
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const used = new Set<number>();
  const picked: Array<{
    sentence: string;
    chunkId: number;
    targetHit: boolean;
    cueHit: boolean;
    definitionalHit: boolean;
  }> = [];
  const seen = new Set<string>();
  const maxItems = analysis.conciseDefinition ? 2 : analysis.conciseEntity ? 2 : analysis.conciseAnswer ? 3 : 5;

  for (const item of scored) {
    const key = normalizeQuestion(item.sentence).slice(0, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    picked.push({
      sentence: item.sentence,
      chunkId: item.chunkId,
      targetHit: item.targetHit,
      cueHit: item.cueHit,
      definitionalHit: item.definitionalHit,
    });
    used.add(item.chunkId);
    if (picked.length >= maxItems) break;
  }

  if (picked.length === 0) return null;

  let pickedSentences = picked;
  if (analysis.conciseDefinition) {
    const anchor = picked.find(
      (item) => item.targetHit && (item.cueHit || item.definitionalHit) && !hasHistoricalCue(item.sentence, questionLang)
    ) || picked.find((item) => item.targetHit && (item.cueHit || item.definitionalHit)) || picked[0];

    const support = picked.find(
      (item) =>
        item !== anchor &&
        !hasHistoricalCue(item.sentence, questionLang) &&
        !isDefinitionBoilerplateSentence(item.sentence, questionLang) &&
        !/(既然|必然|就必然)/.test(item.sentence) &&
        (item.targetHit || item.cueHit || item.definitionalHit)
    );

    pickedSentences = support ? [anchor, support] : [anchor];
  }

  const normalizedSentences = pickedSentences.map((p) =>
    truncateSentenceSmart(
      p.sentence,
      questionLang,
      analysis.conciseDefinition ? (questionLang === "en" ? 220 : 140) : questionLang === "en" ? 180 : 90
    )
      .replace(/，\s*。/g, "。")
      .replace(/；\s*。/g, "。")
      .replace(/。\s*。/g, "。")
      .trim()
  );

  if (analysis.conciseDefinition) {
    const hasStrongDefinitionSentence = pickedSentences.some((item) => {
      const sentenceLower = item.sentence.toLowerCase();
      const targetHit = definitionTargets.some((term) => sentenceLower.includes(term));
      const cueHit = hasDefinitionCue(item.sentence, questionLang);
      const definitionalHit = questionLang === "en"
        ? /\b(is|means|refers to|defined as)\b/i.test(item.sentence)
        : /(?:^|，|。)\s*(?:[^。！？\n]{0,14})(?:是指|指的是|定义为|定义是|是研究|是一种|是一类|是将|是对|是按|是从)/.test(item.sentence);
      return targetHit && (cueHit || definitionalHit);
    });

    if (!hasStrongDefinitionSentence) {
      const definitionSubject = extractDefinitionSubject(question, questionLang) || question.trim();
      const primary = normalizedSentences[0];
      const support = normalizedSentences.slice(1, 2);
      const exampleDriven = questionLang === "en"
        ? /(for example|e\.g\.|case study|experiment|trial|table|figure|\b\d{2,}\b)/i.test(primary)
        : /(例如|比如|试验|实验|图（表）|图表|案例|实例|研究表明|研究发现|可据此|编制|落叶松|毛白杨|欧美杨|山东|黄泛平原|\d{2,})/.test(primary);
      const contextualOnly = questionLang === "en"
        ? !/\b(is|means|refers to|defined as|includes|consists of|can be divided into)\b/i.test(primary) &&
          /(should|need to|management|operation|practice|during|under)/i.test(primary)
        : !/(是指|指的是|定义为|定义是|有.+(种|类|方式|类型)|包括|分为|可分为|由.+组成)/.test(primary) &&
          /(一般|通常|应|需|需要|可|可以|采用|实施|管理|措施|技术|作业|过程|在.+时)/.test(primary);
      const enumOnlyNoDefinition = questionLang === "en"
        ? /(types? include|includes|can be divided into|consists of)/i.test(primary) &&
          !/\b(is|means|refers to|defined as)\b/i.test(primary)
        : /(有.+(种|类|方式|类型)|包括|分为|可分为|由.+组成)/.test(primary) &&
          !/(是指|指的是|定义为|定义是)/.test(primary);
      const supportHasDefinitionCue = support.some((sentence) => hasDefinitionCue(sentence, questionLang));

      if (exampleDriven || contextualOnly || (enumOnlyNoDefinition && !supportHasDefinitionCue)) {
        // 回退到 LLM 概括：示例型句子通常不适合作为“是什么”的直接定义。
        return null;
      }

      if (questionLang === "en") {
        const main = /[.!?…]$/.test(primary)
          ? primary
          : `${primary}.`;
        const supportText = support
          .map((sentence) => (/[.!?…]$/.test(sentence) ? sentence : `${sentence}.`))
          .join(" ");
        return {
          answer: (`Based on the textbook excerpts, "${definitionSubject}" can be understood as: ${main}${supportText ? ` ${supportText}` : ""}`)
            .trim(),
          usedChunkIds: Array.from(used),
          strictDefinition: false,
        };
      }

      const main = /[。！？…]$/.test(primary)
        ? primary
        : `${primary}。`;
      const supportText = support
        .map((sentence) => (/[。！？…]$/.test(sentence) ? sentence : `${sentence}。`))
        .join("");

      return {
        answer: (`根据教材相关表述，“${definitionSubject}”可理解为：${main}${supportText}`).trim(),
        usedChunkIds: Array.from(used),
        strictDefinition: false,
      };
    }

    const text = normalizedSentences
      .map((sentence) => {
        if (questionLang === "en") return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;
        return /[。！？…]$/.test(sentence) ? sentence : `${sentence}。`;
      })
      .join(questionLang === "en" ? " " : "");

    return {
      answer: text.trim(),
      usedChunkIds: Array.from(used),
      strictDefinition: true,
    };
  }

  const lines = normalizedSentences.map((sentence) => {
    if (questionLang === "en") return `- ${/[.!?…]$/.test(sentence) ? sentence : `${sentence}.`}`;
    return `- ${/[。！？…]$/.test(sentence) ? sentence : `${sentence}。`}`;
  });

  const prefix = questionLang === "en"
    ? `Direct excerpt-grounded information about "${question.trim()}":`
    : `教材中关于“${question.trim()}”的直接信息：`;

  return {
    answer: `${prefix}\n${lines.join("\n")}`.replace(/[ \t]+\n/g, "\n").trim(),
    usedChunkIds: Array.from(used),
    strictDefinition: true,
  };
}

async function generateClosestDefinitionFromExcerpts(
  question: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  materialLang: "zh" | "en",
  analysis: QuestionAnalysis
): Promise<string | null> {
  if (!analysis.conciseDefinition || searchResults.length === 0) return null;

  const materialTitles = Array.from(new Set(searchResults.map((r) => r.materialTitle)));
  const systemPrompt = buildSystemPrompt(materialTitles, questionLang, materialLang, analysis);
  const sourceTexts = searchResults
    .slice(0, 4)
    .map((r, idx) => `【片段${idx + 1}】${r.content}`)
    .join("\n\n");

  const userPrompt = questionLang === "en"
    ? `The user asks a definition question: "${question}".
No strict definition sentence (e.g., "is defined as" / "refers to") was found.
Please provide the closest textbook-grounded definition:
1. Start with a direct one-sentence definition synthesized from excerpts.
2. Then give 1-2 concise supporting sentences from excerpts.
3. No external knowledge. No invented facts.
4. Keep total answer within 180 words.

Excerpts:
${sourceTexts}`
    : `用户问的是定义题：“${question}”。
当前片段里没有检索到标准定义句（如“是指/定义为”）。
请基于片段给出“最接近定义”的回答：
1. 先给出一句直接定义（用教材原意概括，不要外推）；
2. 再补1-2句教材支持信息；
3. 只能使用片段信息，不能补充外部知识；
4. 总长度控制在180字以内。

教材片段：
${sourceTexts}`;

  try {
    const response = await invokeLLMWithConfig(
      [{ role: "user", content: userPrompt }],
      systemPrompt,
      { temperature: 0, maxTokens: 320 }
    );
    const parsed = parseLLMOutput(response.content);
    const answer = stripCitationMarkers(parsed ? parsed.answer : response.content);
    const concise = enforceConciseDefinition(answer, questionLang);
    return concise.replace(/\*\*/g, "").replace(/\*/g, "").trim();
  } catch {
    return null;
  }
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
  const questionAnalysis = detectQuestionIntent(req.question, questionLanguage);
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
      searchResults = await semanticSearch(req.question, undefined, pickTopK("en", questionAnalysis), "en", useRAG);
    } else {
      searchResults = await semanticSearch(req.question, undefined, pickTopK("zh", questionAnalysis), "zh", useRAG);
    }
    searchResults = filterNoisySearchResults(searchResults);
    let effectiveResults = questionAnalysis.conciseDefinition
      ? [...searchResults]
      : focusResultsByChapter(req.question, searchResults, questionLanguage, questionAnalysis);
    if (questionAnalysis.conciseDefinition) {
      effectiveResults = await enrichDefinitionResults(
        req.question,
        effectiveResults,
        questionLanguage,
        questionAnalysis
      );
      effectiveResults = filterNoisySearchResults(effectiveResults);
    }
    const sourceLimit = pickSourceLimit(questionLanguage, questionAnalysis);

    if (effectiveResults.length === 0) {
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

    const keywords = questionLanguage === "en" ? extractKeywordsEn(req.question) : extractKeywords(req.question);
    if (questionAnalysis.conciseDefinition) {
      const definitionTargets = pickDefinitionTargets(req.question, keywords, questionLanguage);
      if (definitionTargets.length > 0) {
        const targeted = effectiveResults.filter((row) => {
          const text = `${row.chapter || ""}\n${row.content}`.toLowerCase();
          return definitionTargets.some((term) => text.includes(term));
        });
        if (targeted.length > 0) {
          effectiveResults = targeted;
        }
      }
    }
    const extractive = questionAnalysis.conciseAnswer
      ? buildExtractiveAnswer(req.question, effectiveResults, questionLanguage, questionAnalysis)
      : null;
    if (questionAnalysis.conciseDefinition && !extractive) {
      const fallbackAnswer = await generateClosestDefinitionFromExcerpts(
        req.question,
        effectiveResults,
        questionLanguage,
        questionLanguage,
        questionAnalysis
      );
      const answer = fallbackAnswer || (questionLanguage === "en"
        ? "The provided excerpts do not contain a direct definition sentence for this term."
        : "教材片段中未检索到该术语的直接定义句（如“是指/定义为”）。请尝试补充更具体术语后再问。");
      const fallbackSources = buildSources(effectiveResults, Boolean(fallbackAnswer), keywords, sourceLimit);
      const responseTimeMs = Date.now() - startTime;
      const queryId = await createQuery({
        question: req.question,
        answer,
        sources: fallbackSources,
        modelUsed: "definition-synth",
        responseTimeMs,
        visitorIp: req.visitorIp,
        visitorCity: req.visitorCity,
        visitorRegion: req.visitorRegion,
        visitorCountry: req.visitorCountry,
        visitorLat: req.visitorLat,
        visitorLng: req.visitorLng,
      });
      onMeta({
        sources: fallbackSources,
        modelUsed: "definition-synth",
        foundInMaterials: Boolean(fallbackAnswer),
        confidence: fallbackAnswer ? 0.72 : 0.2,
        questionLanguage,
        queryId,
        responseTimeMs,
      });
      onToken(answer);
      onDone(answer);
      return;
    }
    if (extractive) {
      const conciseResults = effectiveResults.filter((r) => extractive.usedChunkIds.includes(r.chunkId));
      const sources = buildSources(conciseResults, true, keywords, sourceLimit);
      const answer = extractive.answer;
      const strictDefinition = extractive.strictDefinition !== false;
      const extractiveModel = questionAnalysis.conciseDefinition && !strictDefinition ? "extractive-approx" : "extractive";
      const extractiveConfidence = questionAnalysis.conciseDefinition
        ? (strictDefinition ? 0.9 : 0.74)
        : 0.9;
      const responseTimeMs = Date.now() - startTime;
      const queryId = await createQuery({
        question: req.question,
        answer,
        sources,
        modelUsed: extractiveModel,
        responseTimeMs,
        visitorIp: req.visitorIp,
        visitorCity: req.visitorCity,
        visitorRegion: req.visitorRegion,
        visitorCountry: req.visitorCountry,
        visitorLat: req.visitorLat,
        visitorLng: req.visitorLng,
      });
      onMeta({
        sources,
        modelUsed: extractiveModel,
        foundInMaterials: true,
        confidence: extractiveConfidence,
        questionLanguage,
        queryId,
        responseTimeMs,
      });
      onToken(answer);
      onDone(answer);
      return;
    }

    const materialTitles = Array.from(new Set(effectiveResults.map((r) => r.materialTitle)));
    const systemPrompt = buildSystemPrompt(materialTitles, questionLanguage, questionLanguage, questionAnalysis);
    const userMessage = buildUserPrompt(req.question, effectiveResults, questionLanguage, questionAnalysis);
    const sources = buildSources(effectiveResults, true, keywords, sourceLimit);

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
    if (questionAnalysis.conciseAnswer) {
      fullAnswer = enforceConciseDefinition(fullAnswer, questionLanguage);
    }

    // 判断是否找到内容
    const notFoundPhrases = ["未涉及", "not cover", "没有相关", "未找到", "not found"];
    const foundInMaterials = !notFoundPhrases.some((p) => fullAnswer.toLowerCase().includes(p));
    const finalReview = assessAnswerLocally(fullAnswer, effectiveResults, questionAnalysis, questionLanguage);
    if (!finalReview.complete) {
      fullAnswer = appendDegradationNote(fullAnswer, finalReview.downgradeNote);
    }

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
        mainResult: {
          answer: fullAnswer,
          sources,
          modelUsed: model,
          foundInMaterials,
          confidence: foundInMaterials ? (finalReview.complete ? 0.82 : 0.68) : 0.1,
        },
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
