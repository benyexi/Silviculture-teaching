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

type QuestionIntent = "definition" | "classification" | "method" | "comparison" | "condition" | "advantage" | "other";

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

export function detectQuestionIntent(question: string, questionLang: "zh" | "en"): QuestionAnalysis {
  const q = question.toLowerCase();
  const intents: QuestionIntent[] = [];

  if (
    questionLang === "zh"
      ? /(比较|对比|区别|差异|异同|有何不同|怎么区分|区分)/.test(q)
      : /(compare|difference|differences|compare and contrast|versus|vs\.?)/.test(q)
  ) {
    intents.push("comparison");
  }

  if (
    questionLang === "zh"
      ? /(分类|类型|种类|有哪些|包括哪些|几类|几种|分为|可分为|列出|罗列)/.test(q)
      : /(types?|kinds?|categories?|classes?|which kinds|what types|list)/.test(q)
  ) {
    intents.push("classification");
  }

  if (
    questionLang === "zh"
      ? /(方法|方式|步骤|流程|程序|如何|怎么|怎样|实施|操作|处理|进行)/.test(q)
      : /(methods?|ways?|steps?|process|procedure|how to|how do|how should)/.test(q)
  ) {
    intents.push("method");
  }

  if (
    questionLang === "zh"
      ? /(什么是|定义|含义|概念|解释|说明|何谓|是指|指的是)/.test(q)
      : /(what is|define|definition|meaning|concept|explain)/.test(q)
  ) {
    intents.push("definition");
  }

  // V2: 新增"条件/要求"意图
  if (
    questionLang === "zh"
      ? /(条件|要求|前提|必须|需要满足|需要具备|要满足|应具备)/.test(q)
      : /(conditions?|requirements?|prerequisites?|must|criteria)/.test(q)
  ) {
    intents.push("condition");
  }

  // V2: 新增"优缺点"意图
  if (
    questionLang === "zh"
      ? /(优缺点|优点|缺点|利弊|好处|坏处|优势|劣势|长处|短处)/.test(q)
      : /(advantages?|disadvantages?|pros?\b|cons?\b|benefits?|drawbacks?|strengths?|weaknesses?)/.test(q)
  ) {
    intents.push("advantage");
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
    expectsEnumeration: intents.includes("classification") || intents.includes("method") || intents.includes("condition") || intents.includes("advantage"),
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
    condition: "条件/要求题",
    advantage: "优缺点题",
    other: "一般问答",
  };
  const enMap: Record<QuestionIntent, string> = {
    definition: "definition question",
    classification: "classification question",
    method: "method/step question",
    comparison: "comparison question",
    condition: "condition/requirement question",
    advantage: "advantage/disadvantage question",
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
      case "condition":
        return `1. Short overview of the topic\n2. Complete list of conditions/requirements from the excerpts\n3. Brief explanation of each\n4. Completeness note`;
      case "advantage":
        return `1. Short overview\n2. Advantages listed from the excerpts\n3. Disadvantages listed from the excerpts\n4. Summary or recommendation if present`;
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
    case "condition":
      return `1. 简要概述主题\n2. 完整列出教材中明确出现的条件/要求\n3. 逐项简要说明\n4. 说明是否存在教材未覆盖的部分`;
    case "advantage":
      return `1. 简要概述\n2. 列出教材中明确出现的优点/优势\n3. 列出教材中明确出现的缺点/劣势\n4. 总结或建议（如教材有提及）`;
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
**森林培育**是按既定目标和自然规律开展的综合培育活动，涵盖从种子、苗木到成林成熟的全过程[1]。**森林培育学**是研究上述培育活动理论与实践的学科[1]。`;
  }

  if (questionLang === "en") {
    return `Examples:
Example 1 (classification):
Q: What types are mentioned?
A:
## Overview
The excerpts clearly mention several types [1][2].
## Types
1. **Type A**: ... [1]
2. **Type B**: ... [2]
3. **Type C**: ... [3]
## Completeness note
Only the items explicitly mentioned in the excerpts are listed.

Example 2 (method):
Q: What methods or steps are described?
A:
## Overview
The excerpts provide a complete list of the described methods/steps [1].
## Methods / steps
1. **Method 1**: ... [1]
2. **Method 2**: ... [2]
3. **Method 3**: ... [3]
## Notes
If the excerpts only cover part of the topic, say so explicitly.`;
  }

  return `示例1（分类题）：
用户问题：某对象有哪些类型？
回答：
## 一、概述
教材明确提到了若干类型[1][2]。
## 二、类型清单
1. **第一类**：...[1]
2. **第二类**：...[2]
3. **第三类**：...[3]
## 三、完整性说明
以上仅列出教材明确出现的项目，不额外补充。

示例2（方法题）：
用户问题：某操作有哪些方法或步骤？
回答：
## 一、概述
教材给出了完整或部分的方法/步骤[1]。
## 二、方法/步骤清单
1. **方法一**：...[1]
2. **方法二**：...[2]
3. **方法三**：...[3]
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
6. CITATION REQUIRED: For every factual claim, add an inline citation marker like [1], [2] matching the excerpt number. Example: "Silviculture covers the full cultivation cycle [1] including thinning operations [3]."
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
3. 分类题先给"总览 + 完整清单 + 逐项说明"；方法/步骤题先给"总览 + 完整清单 + 逐项说明"；比较题先给"对比表/分点对比 + 结论"。
4. 如果教材只覆盖部分内容，要明确说明"教材只明确提到以下项目"，不要补外部知识。
5. 回答前先在内部检查一次：是否覆盖所有相关片段、是否存在漏项、是否还带有教材外补充。检查不过就重写。
6. 直接输出 Markdown，不要包裹在 JSON 或代码块中。
7. 引用标注：每个事实性陈述后必须添加引用标记 [1]、[2]，对应片段编号。例如："森林培育涵盖从种子到成林的全过程[1]，包括间伐经营[3]。"
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
7. Inline citations: add [1], [2], [3] etc. after each factual claim, matching the excerpt number it came from. Every key statement must have at least one citation.

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
3. 结构清晰：${analysis.conciseDefinition ? `直接按"定义句 + 1-2句补充说明"输出。` : `按照"定义与概述→分类/类型→具体方法/步骤→原则与注意事项→应用场景"等逻辑顺序组织。`} ${buildAnswerBlueprint(analysis, questionLang)}
4. 突出重点：使用 **加粗** 标记关键术语、重要概念和核心结论。对于教材中的数据、公式、比例等要精确引用。
5. 保留教材表述：尽量使用教材中的原始术语和表述，可以适当组织和概括，但核心信息必须来自教材。如果教材中有多个观点或说法，应完整列出。
6. 格式规范：${analysis.conciseDefinition ? "直接输出 Markdown，2-4句即可，不要使用长篇多级标题。" : "直接输出 Markdown 格式，不要包裹在 JSON 或代码块中。开头先用1-2句话概括主题，再展开详细内容。"}
7. 内联引用标注：每个事实性陈述后必须添加 [1]、[2]、[3] 等标记，对应其来自的片段编号。每个关键陈述至少有一个引用标记。例如：造林密度取决于立地条件[2]和树种特性[4]。
${analysis.conciseDefinition ? `\n8. 当前是简洁定义题，仅回答定义本身（2-4句），不得扩展到历史、分类、目的、发展、问题等延伸内容。` : ""}

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

Completion constraints (Strict Grounding Mode):
- You may ONLY use the excerpts below. Never use pre-trained knowledge to fabricate content.
- If the excerpts don't contain the answer, say "The provided textbook excerpts do not cover this topic."
- Add citation markers [1], [2] etc. after every factual claim, referencing the excerpt number.
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

【完整性约束（严格 Grounding 模式）】
- 你只能基于下方教材片段回答，绝对不能根据预训练知识编造内容。
- 如果片段中没有答案，直接告知"教材中未涉及此内容"。
- 每个事实性陈述后必须标注来源片段编号，如 [1]、[2]。
- 如果是分类/方法/步骤/比较题，必须把教材中明确出现的项目全部列出。
- 不要只写概述，必须先总述再逐项展开。
- 如果教材只覆盖部分内容，要明确说明"教材只明确提到以下项目"。
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
  if (analysis.conciseAnswer) return 3;
  if (analysis.intent === "definition") return questionLang === "en" ? 4 : 5;
  if (analysis.requestDetail) return questionLang === "en" ? 8 : 9;
  if (analysis.expectsFullCoverage) return questionLang === "en" ? 6 : 7;
  return questionLang === "en" ? 5 : 6;
}

function pickTopK(questionLang: "zh" | "en", analysis: QuestionAnalysis, forAuxEnglish = false): number {
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

  const keywords = questionLang === "en" ? extractKeywordsEn(question) : extractKeywords(question);
  let effectiveResults = analysis.conciseDefinition
    ? [...searchResults]
    : focusResultsByChapter(question, searchResults, questionLang, analysis);
  if (analysis.conciseDefinition) {
    effectiveResults = await enrichDefinitionResults(question, effectiveResults, questionLang, analysis);
  }
  const sourceLimit = pickSourceLimit(questionLang, analysis);
  const materialTitles = Array.from(new Set(effectiveResults.map((r) => r.materialTitle)));
  const extractive = analysis.conciseAnswer
    ? buildExtractiveAnswer(question, effectiveResults, questionLang, analysis)
    : null;
  if (extractive) {
    const conciseResults = effectiveResults.filter((r) => extractive.usedChunkIds.includes(r.chunkId));
    const sources = buildSources(conciseResults, true, keywords, sourceLimit);
    return {
      answer: extractive.answer,
      sources,
      modelUsed: "extractive",
      foundInMaterials: true,
      confidence: 0.9,
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
  const grounding = assessGrounding(answer, effectiveResults, questionLang);

  // V2: 统一质量管线（最多 1 次额外 LLM 调用，替代原来的多级串行调用）
  // 决策逻辑：
  //   1. 本地审校通过 + grounding通过 → 直接输出
  //   2. 有质量问题 → 一次性 LLM 质量评估+重写（合并了审校修正、grounding重写、质量门控）
  //   3. 简洁回答模式 → 跳过 LLM 审校
  const compactLen = answer.replace(/\s+/g, "").length;
  const structuredItems = countStructuredItems(answer);
  const skipLLMReview = analysis.conciseAnswer || (localReview.complete && grounding.grounded) ||
    (compactLen > 200 && structuredItems >= 3 && grounding.grounded);

  if (!skipLLMReview && (localReview.shouldRetry || !grounding.grounded)) {
    // 收集所有问题，一次性交给 LLM 评估+修正
    const allIssues = [...localReview.issues];
    if (!grounding.grounded) {
      allIssues.push(questionLang === "en"
        ? `Answer contains claims not grounded in excerpts (grounding score: ${grounding.score.toFixed(2)}). Rewrite using only excerpt content.`
        : `答案包含教材片段中没有依据的内容（接地分: ${grounding.score.toFixed(2)}），需要严格基于片段重写。`);
    }

    // 先做 LLM 质量评估（判断是否真的需要重写）
    const qualityResult = await evaluateAnswerQuality(
      question, answer, effectiveResults, questionLang, analysis
    );

    if (!qualityResult.pass || !grounding.grounded) {
      const combinedFeedback = [
        ...allIssues,
        ...(qualityResult.feedback ? [qualityResult.feedback] : []),
      ].join("; ");

      try {
        const regenerated = await invokeLLMWithConfig(
          [{ role: "user", content: buildQualityRegeneratePrompt(
            question, answer, effectiveResults, questionLang, analysis, combinedFeedback
          ) }],
          buildSystemPrompt(materialTitles, questionLang, materialLang, analysis),
          { temperature: 0 }
        );
        const regenParsed = parseLLMOutput(regenerated.content);
        const regenAnswer = stripCitationMarkers(regenParsed ? regenParsed.answer : regenerated.content);
        if (regenAnswer.replace(/\s+/g, "").length >= answer.replace(/\s+/g, "").length * 0.8) {
          answer = regenAnswer;
        }
      } catch {
        // 重写失败时保留原答案
      }
    }
  }

  const finalReview = assessAnswerLocally(answer, effectiveResults, analysis, questionLang);
  if (!finalReview.complete) {
    answer = appendDegradationNote(answer, finalReview.downgradeNote);
  }

  // 判断是否在教材中找到了内容
  const notFoundPhrases = ["未涉及", "not cover", "没有相关", "未找到", "not found"];
  const foundInMaterials = !notFoundPhrases.some((p) => answer.toLowerCase().includes(p));

  const sources = buildSources(effectiveResults, foundInMaterials, keywords, sourceLimit);

  const confidence = finalReview.complete ? 0.82 : localReview.shouldRetry ? 0.58 : 0.68;

  return {
    answer,
    sources,
    modelUsed: llmResponse.model,
    foundInMaterials,
    confidence: foundInMaterials ? confidence : 0.1,
  };
}

/** V2: 清理非标准引用格式，但保留正规的 [1] [2] 引用标记 */
export function stripCitationMarkers(text: string): string {
  const cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // 清除非标准格式（如 [citation_indices: 1,2]、[引用1]、【片段1】）
    .replace(/\[citation_indices?:\s*[\d,\s]+\]/gi, "")
    .replace(/\[引用\d+\]/g, "")
    .replace(/【?片段\d+】?/g, "")
    .replace(/片段\[?\d+\]?至?\[?\d*\]?/g, "")
    // 标准化引用标记格式：确保 [1] [2] 等格式一致
    .replace(/\[\s*(\d+)\s*\]/g, "[$1]");

  return normalizeMarkdownSpacing(cleaned);
}

function normalizeMarkdownSpacing(text: string): string {
  return text
    .replace(/([^\n])\s+(#{1,6}\s+)/g, "$1\n\n$2")
    .replace(/\n[ \t]*([#>-])/g, "\n$1")
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

/** V2: 合并审校+修正为一次 LLM 调用 */
function buildReviewAndFixPrompt(
  question: string,
  answer: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis,
  localIssues: string[]
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
    return `Review the answer below and output a corrected, complete version directly.
Question intent: ${describeIntent(analysis.intent, "en")}
Question: ${question}

Issues found:
- ${localIssues.join("\n- ")}

Current answer:
${answer}

Textbook excerpts:
${sourceTexts}

Instructions:
1. Check if the answer covers all items explicitly mentioned in the excerpts.
2. If incomplete, output the full corrected answer in Markdown.
3. If already complete, output the answer unchanged.
4. Do not mention the review process. Do not wrap in JSON.
5. For classification/method/step/comparison questions, enumerate every item from the excerpts.`;
  }

  return `请审校下方答案，并直接输出修正后的完整版本。
问题意图：${describeIntent(analysis.intent, "zh")}
学生问题：${question}

发现的问题：
- ${localIssues.join("\n- ")}

当前答案：
${answer}

教材片段：
${sourceTexts}

要求：
1. 检查答案是否完整覆盖了教材片段中明确出现的项目。
2. 如有遗漏，直接输出修正后的完整 Markdown 答案。
3. 如果已经完整，原样输出。
4. 不要提及审校过程。不要用 JSON 包裹。
5. 分类/方法/步骤/比较题必须把教材中明确出现的项目全部列出。`;
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
  return { grounded: score >= 0.62, score };
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
3. 每个事实性陈述后添加引用标记 [1]、[2] 对应片段编号。
4. ${analysis.conciseDefinition ? "这是简洁定义题，仅用2-4句。禁止历史背景和延伸。" : "按问题类型组织结构，但不要超出片段。"}

教材片段：
${sourceTexts}`;
}

// ─── V2: LLM 质量门控 ────────────────────────────────────────────────────────
// 独立评估答案质量：完整性、准确性、结构、引用，不合格则触发重新生成

type QualityEvaluation = {
  pass: boolean;
  score: number;      // 0~10
  feedback: string;   // 改进建议（不合格时）
};

async function evaluateAnswerQuality(
  question: string,
  answer: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): Promise<QualityEvaluation> {
  // 短答案或片段不足时跳过 LLM 评估，用本地规则替代
  const compactLen = answer.replace(/\s+/g, "").length;
  if (compactLen < 60 || searchResults.length < 2) {
    return { pass: true, score: 7, feedback: "" };
  }

  const sourceSnippets = searchResults
    .slice(0, 6)
    .map((r, idx) => `[${idx + 1}] ${r.content.substring(0, 200)}`)
    .join("\n");

  const evalPrompt = questionLang === "en"
    ? `You are an answer quality evaluator for a silviculture teaching assistant.
Evaluate this answer on 4 dimensions (each 0-10):
1. **Completeness**: Does it cover all key points from the excerpts?
2. **Accuracy**: Is every claim grounded in the excerpts? No fabrication?
3. **Structure**: Is it well-organized with clear headings/lists for the question type (${describeIntent(analysis.intent, "en")})?
4. **Citations**: Does it use [1], [2] markers properly?

Question: ${question}

Answer:
${answer}

Source excerpts:
${sourceSnippets}

Return JSON only:
{"score": <average 0-10>, "pass": <true if score>=6.5>, "feedback": "<specific improvement suggestions if not pass, empty string if pass>"}`
    : `你是森林培育学教学助手的答案质量评估器。
请从4个维度评分（每项0-10分）：
1. **完整性**：是否覆盖了教材片段中的关键要点？
2. **准确性**：每个论述是否有教材依据？有无编造？
3. **结构性**：对于${describeIntent(analysis.intent, "zh")}，结构是否清晰（标题/列表/分点）？
4. **引用标注**：是否正确使用了 [1]、[2] 等引用标记？

学生问题：${question}

当前答案：
${answer}

教材片段：
${sourceSnippets}

只返回 JSON：
{"score": <四项平均分 0-10>, "pass": <true 若 score>=6.5>, "feedback": "<不合格时的具体改进建议，合格则为空字符串>"}`;

  try {
    const evalResponse = await invokeLLMWithConfig(
      [{ role: "user", content: evalPrompt }],
      questionLang === "en"
        ? "You are a strict answer quality evaluator. Return only valid JSON."
        : "你是严格的答案质量评估器。只返回有效 JSON。",
      { temperature: 0, maxTokens: 300, responseFormat: "json_object" }
    );

    const parsed = parseQualityEvaluation(evalResponse.content);
    if (parsed) {
      console.log(`[QualityGate] Score: ${parsed.score}/10, Pass: ${parsed.pass}${parsed.feedback ? `, Feedback: ${parsed.feedback.substring(0, 80)}` : ""}`);
      return parsed;
    }
  } catch (err: any) {
    console.warn(`[QualityGate] Evaluation failed: ${err?.message || err}`);
  }

  // 评估失败时默认通过（不阻塞输出）
  return { pass: true, score: 7, feedback: "" };
}

function parseQualityEvaluation(content: string): QualityEvaluation | null {
  try {
    const parsed = JSON.parse(content.trim());
    if (typeof parsed.score === "number" && typeof parsed.pass === "boolean") {
      return {
        score: parsed.score,
        pass: parsed.pass,
        feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
      };
    }
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.score === "number" && typeof parsed.pass === "boolean") {
          return {
            score: parsed.score,
            pass: parsed.pass,
            feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
          };
        }
      } catch {
        // noop
      }
    }
  }
  return null;
}

function buildQualityRegeneratePrompt(
  question: string,
  previousAnswer: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis,
  qualityFeedback: string
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
    return `The previous answer was evaluated and found to have quality issues.

Quality feedback: ${qualityFeedback}

Question intent: ${describeIntent(analysis.intent, "en")}
Question: ${question}

Previous answer (needs improvement):
${previousAnswer}

Textbook excerpts:
${sourceTexts}

Please generate an improved answer that:
1. Addresses all quality feedback above
2. Covers all key points from the excerpts
3. Uses proper [1], [2] citation markers
4. Has clear structure appropriate for the question type
5. Does not fabricate information beyond the excerpts`;
  }

  return `上一版答案经质量评估未达标，需要改进。

质量反馈：${qualityFeedback}

问题类型：${describeIntent(analysis.intent, "zh")}
学生问题：${question}

上一版答案（需改进）：
${previousAnswer}

教材片段：
${sourceTexts}

请生成改进后的答案：
1. 针对上述质量反馈逐项改进
2. 完整覆盖教材片段中的关键要点
3. 正确使用 [1]、[2] 引用标记
4. 结构清晰，符合问题类型
5. 不得编造教材片段以外的信息`;
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
  return /(是指|指的是|定义|概念|含义|是研究|是一门|是.*?学科)/.test(text);
}

function hasHistoricalCue(text: string, questionLang: "zh" | "en"): boolean {
  if (questionLang === "en") {
    return /\b(history|historical|century|in \d{4}|during)\b/i.test(text);
  }
  return /(历史|发展|20世纪|年代|文革|出版|编写|奠基|繁荣)/.test(text);
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
      const targetHits = targets.filter((term) => text.toLowerCase().includes(term)).length;
      const cue = hasDefinitionCue(row.content, questionLang) ? 1 : 0;
      const history = hasHistoricalCue(text, questionLang) ? 1 : 0;
      const score = row.similarity * 2.5 + targetHits * 2.6 + cue * 3.8 - history * 1.8;
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
    questionLang === "en" ? `${subject} definition concept refers to` : `${subject} 定义 概念 是指`;

  try {
    const extraResults = await semanticSearch(
      expandedQuery,
      undefined,
      Math.max(6, pickTopK(questionLang, analysis) + 2),
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

    return unique.slice(0, Math.max(searchResults.length, pickTopK(questionLang, analysis) + 2));
  } catch {
    return searchResults;
  }
}

function buildExtractiveAnswer(
  question: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): { answer: string; usedChunkIds: number[] } | null {
  const queryNorm = normalizeQuestion(question);
  const keywords = (questionLang === "en" ? extractKeywordsEn(question) : extractKeywords(question))
    .filter((k) => k.length >= 2)
    .slice(0, 8);
  const definitionTargets = analysis.conciseDefinition
    ? pickDefinitionTargets(question, keywords, questionLang)
    : [];
  const effectiveResults = analysis.conciseDefinition
    ? prioritizeDefinitionResults(question, searchResults, questionLang, keywords)
    : searchResults;

  const scored: Array<{ sentence: string; score: number; chunkId: number }> = [];
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
      let score = 0;
      if (queryNorm && sNorm.includes(queryNorm)) score += 8;
      for (const kw of keywords) {
        if (sNorm.includes(normalizeQuestion(kw))) score += Math.min(4, kw.length);
      }
      if (analysis.conciseDefinition) {
        const sentenceLower = sentence.toLowerCase();
        const targetHit = definitionTargets.some((term) => sentenceLower.includes(term));
        const cueHit = hasDefinitionCue(sentence, questionLang);
        if (targetHit) score += 6;
        if (cueHit) score += 7;
        if (targetHit && cueHit) score += 8;
        if (hasHistoricalCue(sentence, questionLang)) score -= 4;
      }
      if (score > 0) scored.push({ sentence, score, chunkId: chunk.chunkId });
    }
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const used = new Set<number>();
  const picked: Array<{ sentence: string; chunkId: number }> = [];
  const seen = new Set<string>();
  const maxItems = analysis.conciseDefinition ? 2 : analysis.conciseAnswer ? 3 : 5;

  for (const item of scored) {
    const key = normalizeQuestion(item.sentence).slice(0, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    picked.push({ sentence: item.sentence, chunkId: item.chunkId });
    used.add(item.chunkId);
    if (picked.length >= maxItems) break;
  }

  if (picked.length === 0) return null;

  const lines = picked.map((p) => {
    const trimmed = truncateSentenceSmart(p.sentence, questionLang, questionLang === "en" ? 180 : 90);
    if (questionLang === "en") return `- ${trimmed}${/[.!?…]$/.test(trimmed) ? "" : "."}`;
    return `- ${trimmed}${/[。！？…]$/.test(trimmed) ? "" : "。"} `;
  });

  const prefix = questionLang === "en"
    ? `Direct excerpt-grounded information about "${question.trim()}":`
    : `教材中关于"${question.trim()}"的直接信息：`;

  return {
    answer: `${prefix}\n${lines.join("\n")}`.replace(/[ \t]+\n/g, "\n").trim(),
    usedChunkIds: Array.from(used),
  };
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
    const extractive = questionAnalysis.conciseAnswer
      ? buildExtractiveAnswer(req.question, effectiveResults, questionLanguage, questionAnalysis)
      : null;
    if (extractive) {
      const conciseResults = effectiveResults.filter((r) => extractive.usedChunkIds.includes(r.chunkId));
      const sources = buildSources(conciseResults, true, keywords, sourceLimit);
      const answer = extractive.answer;
      const responseTimeMs = Date.now() - startTime;
      const queryId = await createQuery({
        question: req.question,
        answer,
        sources,
        modelUsed: "extractive",
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
        modelUsed: "extractive",
        foundInMaterials: true,
        confidence: 0.9,
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

    // V2: 流式模式下的统一质量管线（与 sync 模式一致）
    // 前端 done 事件会用 fullAnswer 替换已流式输出的内容
    const localReview = assessAnswerLocally(fullAnswer, effectiveResults, questionAnalysis, questionLanguage);
    const grounding = assessGrounding(fullAnswer, effectiveResults, questionLanguage);

    const compactLen = fullAnswer.replace(/\s+/g, "").length;
    const structuredItems = countStructuredItems(fullAnswer);
    const skipStreamReview = questionAnalysis.conciseAnswer ||
      (localReview.complete && grounding.grounded) ||
      (compactLen > 200 && structuredItems >= 3 && grounding.grounded);

    if (!skipStreamReview && (localReview.shouldRetry || !grounding.grounded) && effectiveResults.length >= 2) {
      const allIssues = [...localReview.issues];
      if (!grounding.grounded) {
        allIssues.push(questionLanguage === "en"
          ? `Answer contains ungrounded claims (score: ${grounding.score.toFixed(2)}). Rewrite using only excerpts.`
          : `答案包含无依据内容（接地分: ${grounding.score.toFixed(2)}），需严格基于片段重写。`);
      }
      const qualityResult = await evaluateAnswerQuality(
        req.question, fullAnswer, effectiveResults, questionLanguage, questionAnalysis
      );
      if (!qualityResult.pass || !grounding.grounded) {
        const combinedFeedback = [...allIssues, ...(qualityResult.feedback ? [qualityResult.feedback] : [])].join("; ");
        try {
          const regenerated = await invokeLLMWithConfig(
            [{ role: "user", content: buildQualityRegeneratePrompt(
              req.question, fullAnswer, effectiveResults, questionLanguage, questionAnalysis, combinedFeedback
            ) }],
            systemPrompt,
            { temperature: 0 }
          );
          const regenParsed = parseLLMOutput(regenerated.content);
          const regenAnswer = stripCitationMarkers(regenParsed ? regenParsed.answer : regenerated.content);
          if (regenAnswer.replace(/\s+/g, "").length >= fullAnswer.replace(/\s+/g, "").length * 0.8) {
            fullAnswer = regenAnswer;
          }
        } catch {
          // 重写失败时保留原答案
        }
      }
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
