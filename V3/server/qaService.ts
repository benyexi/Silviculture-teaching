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

function normalizeMaterialIds(materialIds?: number[]): number[] | undefined {
  if (!materialIds || materialIds.length === 0) return undefined;
  const normalized = Array.from(
    new Set(materialIds.filter((id) => Number.isInteger(id) && id > 0))
  ).sort((a, b) => a - b);
  return normalized.length > 0 ? normalized : undefined;
}

function buildCacheKey(question: string, materialIds?: number[]): string {
  const scope = normalizeMaterialIds(materialIds);
  const scopeKey = scope ? scope.join(",") : "all";
  return `${scopeKey}::${normalizeQuestion(question)}`;
}

function getCachedAnswer(question: string, materialIds?: number[]): CachedAnswer | null {
  const key = buildCacheKey(question, materialIds);
  const cached = answerCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
    answerCache.delete(key);
    return null;
  }
  return cached;
}

function setCachedAnswer(
  question: string,
  data: Omit<CachedAnswer, "cachedAt">,
  materialIds?: number[]
): void {
  // 超出容量时清理最旧的条目
  if (answerCache.size >= CACHE_MAX_SIZE) {
    const firstKey = answerCache.keys().next().value;
    if (firstKey !== undefined) answerCache.delete(firstKey);
  }
  answerCache.set(buildCacheKey(question, materialIds), { ...data, cachedAt: Date.now() });
}

/** 教材更新时清空缓存，保证答案基于最新教材 */
export function clearAnswerCache(): void {
  answerCache.clear();
}

export type QARequest = {
  question: string;
  materialIds?: number[];
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

const TOKEN_SAVER_MODE = process.env.TOKEN_SAVER_MODE !== "false";
const ENABLE_LLM_QUALITY_REVIEW = process.env.ENABLE_LLM_QUALITY_REVIEW !== "false";
const ENABLE_LLM_REWRITE = process.env.ENABLE_LLM_REWRITE !== "false";
const ENABLE_AUX_EN_ANSWER = process.env.ENABLE_AUX_EN_ANSWER === "true";

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
      ? /(条件|要求|前提|必须|需要满足|需要具备|要满足|应具备|何时|什么时候|时机|时间|时期|季节)/.test(q)
      : /(conditions?|requirements?|prerequisites?|must|criteria|when|timing|time to|best time|season)/.test(q)
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
  const hasActionIntent = intents.some((intent) =>
    intent === "classification" ||
    intent === "method" ||
    intent === "comparison" ||
    intent === "condition" ||
    intent === "advantage"
  );
  const shortEntityDefinition = isVeryShort && !requestDetail && !hasActionIntent;
  if (shortEntityDefinition && !intents.includes("definition")) {
    intents.unshift("definition");
  }
  const hasTimingCue =
    questionLang === "zh"
      ? /(何时|什么时候|时机|时间|时期|季节)/.test(q)
      : /\b(when|timing|time to|best time|season|timely)\b/.test(q);
  const conciseEntity = isVeryShort && !requestDetail && intents.length === 1 && intents[0] === "other";
  const intent = hasTimingCue && intents.includes("condition") ? "condition" : intents[0];
  const conciseDefinition = !requestDetail && (intent === "definition" || shortEntityDefinition);

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
        return `1. Directly list all types/classes mentioned in the excerpts\n2. Item-by-item explanation in short lines`;
      case "method":
        return `1. Directly list all methods/steps mentioned in the excerpts\n2. Key points for each item`;
      case "comparison":
        return `1. Objects being compared\n2. Side-by-side comparison table\n3. Key differences and conclusion`;
      case "condition":
        return `1. Directly list all conditions/requirements or timing windows mentioned in the excerpts\n2. Brief explanation of each item`;
      case "advantage":
        return `1. Directly list all advantages/disadvantages mentioned in the excerpts\n2. Brief explanation of each item`;
      case "definition":
        return analysis.conciseDefinition
          ? `1. One direct definition sentence\n2. 1-2 supporting sentences from excerpts\n3. Stop; no background expansion`
          : `1. Direct definition\n2. Key features or boundaries\n3. Related explanation or application`;
      default:
        if (analysis.conciseEntity) {
          return `1. Directly state what the excerpts say about the queried term/person\n2. Give 1-3 excerpt-grounded facts\n3. Stop; no expansion`;
        }
        return `1. Direct answer first\n2. Structured explanation with only key points`;
    }
  }

  switch (analysis.intent) {
    case "classification":
      return `1. 直接列出教材中的类型/分类/条目\n2. 每项用1-2句说明`;
    case "method":
      return `1. 直接列出教材中的方法/步骤\n2. 逐项说明条件、要点或作用`;
    case "comparison":
      return `1. 说明比较对象\n2. 用对比表或分点对比列出差异\n3. 给出结论`;
    case "condition":
      return `1. 直接列出教材中的条件/要求或时间时机\n2. 逐项简要说明`;
    case "advantage":
      return `1. 直接列出教材中的优点/优势/缺点\n2. 逐项简要说明`;
    case "definition":
      return analysis.conciseDefinition
        ? `1. 直接给出一句最直接定义\n2. 再补1-2句教材内关键说明\n3. 到此结束，不延伸历史、分类、目的等`
        : `1. 先给出定义或核心含义\n2. 补充关键特征、边界或作用\n3. 结合教材语境做简短解释`;
    default:
      if (analysis.conciseEntity) {
        return `1. 直接回答教材中关于该词/人名的明确信息\n2. 只列1-3条片段内事实\n3. 到此结束，不展开延伸`;
      }
      return `1. 直接回答问题\n2. 结构化展开关键要点`;
  }
}

function buildFewShot(questionLang: "zh" | "en", analysis: QuestionAnalysis): string {
  if (analysis.intent === "definition" && analysis.conciseDefinition) {
    if (questionLang === "en") {
    return `Example (concise definition):
Q: What is silviculture?
A:
Silviculture is the discipline that studies forest cultivation theory and practice.
It covers the cultivation process from seeds/seedlings to stand establishment and maturity.`;
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
## Types
1. **Type A**: ... [1]
2. **Type B**: ... [2]
3. **Type C**: ... [3]

Example 2 (method):
Q: What methods or steps are described?
A:
## Methods / steps
1. **Method 1**: ... [1]
2. **Method 2**: ... [2]
3. **Method 3**: ... [3]`;
  }

  return `示例1（分类题）：
用户问题：某对象有哪些类型？
回答：
## 类型清单
1. **第一类**：...[1]
2. **第二类**：...[2]
3. **第三类**：...[3]

示例2（方法题）：
用户问题：某操作有哪些方法或步骤？
回答：
## 方法/步骤清单
1. **方法一**：...[1]
2. **方法二**：...[2]
3. **方法三**：...[3]`;
}

function buildFewShotBlock(questionLang: "zh" | "en", analysis: QuestionAnalysis): string {
  if (!TOKEN_SAVER_MODE) return buildFewShot(questionLang, analysis);
  if (analysis.conciseDefinition || analysis.expectsEnumeration || analysis.intent === "comparison") {
    return buildFewShot(questionLang, analysis);
  }
  return "";
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
3. Do not stop at a summary sentence when the question asks for types, methods, steps, conditions, timing, or differences.
4. If the excerpts only cover part of the topic, say so plainly and do not invent missing items.
5. Use Markdown only. Do not wrap the final answer in JSON or code fences.
6. CITATION REQUIRED: For every factual claim, add an inline citation marker like [1], [2] matching the excerpt number. Example: "Silviculture covers the full cultivation cycle [1] including thinning operations [3]."
7. Never add background history or external knowledge not supported by excerpts.
8. Do not add meta commentary like "the textbook clearly states", "completeness note", or process explanations.
9. Do not output exclusion paragraphs such as "X is not covered / not listed" unless the user explicitly asks what is missing.`;
  }

  const materialNote =
    materialLang === "en"
      ? "教材片段为英文或英中混合，回答时可先保留关键英文术语，再用中文解释。"
      : "教材片段为中文，优先使用教材原词。";

  return `你是北京林业大学森林培育学科的专业教学助手，只能基于提供的教材片段回答。
${materialNote}

回答协议：
1. 先识别问题意图：${describeIntent(analysis.intent, "zh")}。
2. 如果问题是分类、方法、步骤、条件/时机或比较题，必须完整列出教材中明确出现的项目，不得只给总述。
3. 分类题先给"总览 + 完整清单 + 逐项说明"；方法/步骤题先给"总览 + 完整清单 + 逐项说明"；比较题先给"对比表/分点对比 + 结论"。
4. 如果教材只覆盖部分内容，要明确说明"教材只明确提到以下项目"，不要补外部知识。
5. 回答前先在内部检查一次：是否覆盖所有相关片段、是否存在漏项、是否还带有教材外补充。检查不过就重写。
6. 直接输出 Markdown，不要包裹在 JSON 或代码块中。
7. 引用标注：每个事实性陈述后必须添加引用标记 [1]、[2]，对应片段编号。例如："森林培育涵盖从种子到成林的全过程[1]，包括间伐经营[3]。"
8. 严禁扩展教材外知识，不要凭常识或通用知识补充。
9. 禁止写过程性废话或自我说明，如"教材明确将…""完整性说明""本回答完全限定于…"。答案第一句必须直接进入结论或清单。
10. 证据不足时只用一句短提示，不要展开排除说明；除非用户明确问"哪些没有提到"，才可以说明缺失项。`;
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
1. Source only: use only the provided excerpts. Do not add outside knowledge. If not covered, reply with a single short sentence and stop.
2. ${analysis.conciseDefinition ? "Concise definition mode: answer only the core definition from excerpts in 2-4 sentences, with the first sentence being the direct answer." : "Completeness: synthesize ALL provided excerpts thoroughly. For classification/method/step/comparison questions, list every item that appears in the excerpts."}
3. Structure: follow this blueprint: ${buildAnswerBlueprint(analysis, questionLang)}. Do not add a preface like 'the textbook says' or 'excerpt-grounded'.
4. Key terms: use **bold** for key terms, important concepts, and critical conclusions. Precisely preserve numeric data, formulas, and ratios from the textbook.
5. Textbook language: preserve original terminology. If multiple viewpoints exist, list them all.
6. ${analysis.conciseDefinition ? "Format: output plain concise Markdown in 2-4 sentences; do not use long sectioned expansion." : "Format: output directly in Markdown. Start with a 1-2 sentence overview, then expand with full details."}
7. Inline citations: add [1], [2], [3] etc. after each factual claim, matching the excerpt number it came from. Every key statement must have at least one citation.

${analysis.conciseDefinition ? "8. This is a concise definition question. Answer in 2-4 sentences only; do not add history, classification, purpose, development, or other extensions." : ""}

${buildFewShotBlock(questionLang, analysis)}`;
  }

  if (materialLang === "en") {
    return `${buildSystemHeader(questionLang, materialLang, analysis)}

下面是英文教材相关段落，请基于这些英文教材内容，用中文回答问题。
回答时：
1. 先给出英文教材的关键原文或关键术语（1-2句）
2. 再给出中文翻译和解释
3. 若问题属于分类/方法/步骤/比较题，必须完整列出教材中明确出现的项目，不能只给概述
4. 直接进入答案，不要先写“教材中关于…”或“根据片段…”之类的引导语；如果证据不足，只用一句短提示。

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
3. 结构清晰：${analysis.conciseDefinition ? `直接按"定义句 + 1-2句补充说明"输出。` : `优先"直接回答 + 清单/要点"。`} ${buildAnswerBlueprint(analysis, questionLang)}
4. 突出重点：使用 **加粗** 标记关键术语、重要概念和核心结论。对于教材中的数据、公式、比例等要精确引用。
5. 保留教材表述：尽量使用教材中的原始术语和表述，可以适当组织和概括，但核心信息必须来自教材。如果教材中有多个观点或说法，应完整列出。
6. 格式规范：${analysis.conciseDefinition ? "直接输出 Markdown，2-4句即可，不要使用长篇多级标题，也不要写导语。" : "直接输出 Markdown 格式，不要包裹在 JSON 或代码块中。不要求固定写'一、概述/三、完整性说明'。"}
7. 内联引用标注：每个事实性陈述后必须添加 [1]、[2]、[3] 等标记，对应其来自的片段编号。每个关键陈述至少有一个引用标记。例如：造林密度取决于立地条件[2]和树种特性[4]。
${analysis.conciseDefinition ? `\n8. 当前是简洁定义题，仅回答定义本身（2-4句），不得扩展到历史、分类、目的、发展、问题等延伸内容。` : ""}

${buildFewShotBlock(questionLang, analysis)}`;
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
- If the excerpts don't contain the answer, reply with one short sentence and stop.
- Add citation markers [1], [2] etc. after every factual claim, referencing the excerpt number.
- If the question asks for types, methods, steps, or comparisons, list every item explicitly mentioned in the excerpts.
- Do not stop at a summary sentence.
- If the excerpts only cover part of the topic, say so briefly and directly.
- ${analysis.intent === "condition" ? "Use `## Timing / requirements` and provide a numbered list." : "Use short structured sections only when needed."}
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
- 如果片段中没有答案，直接用一句短提示，不要解释原因，也不要列出排除项。
- 每个事实性陈述后必须标注来源片段编号，如 [1]、[2]。
- 如果是分类/方法/步骤/比较题，必须把教材中明确出现的项目全部列出。
- 直接列与问题最相关的条目，第一句必须直接进入答案，不要写导语。
- 仅在确实缺失且用户明确追问缺失内容时，用1句短注说明，不要扩展解释过程。
${analysis.conciseDefinition ? "- 这是简洁定义题：只用2-4句话回答定义本身，禁止历史背景/分类/目的等延伸。" : ""}
${analysis.intent === "method" ? "- 格式硬性要求：必须使用 `## 核心结论` + `## 具体做法` 两个二级标题；“具体做法”下用编号列表逐条写。" : ""}
${analysis.intent === "classification" ? "- 格式硬性要求：必须使用 `## 类型总览` + `## 逐项说明` 两个二级标题；“逐项说明”下用编号列表逐条写。" : ""}

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

function uniqueSortedTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const cleaned = term.trim();
    if (!cleaned) continue;
    const key = normalizeForFocus(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out.sort((a, b) => b.length - a.length);
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
  if (analysis.expectsEnumeration) return searchResults;
  if (analysis.requestDetail) return searchResults;

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

  // 仅在单章节优势非常明显时才收缩，避免跨章节条目题丢失要点
  const strictShouldFocus =
    shouldFocus &&
    coverageRatio >= 0.58 &&
    dominance >= 1.28 &&
    best.rows.length >= 4;

  if (!strictShouldFocus) return sorted;

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

function pickPromptChunkBudget(questionLang: "zh" | "en", analysis: QuestionAnalysis): number {
  if (analysis.conciseAnswer) return questionLang === "en" ? 2 : 3;
  if (analysis.requestDetail) return TOKEN_SAVER_MODE ? (questionLang === "en" ? 4 : 6) : (questionLang === "en" ? 6 : 9);
  if (analysis.expectsFullCoverage) return TOKEN_SAVER_MODE ? (questionLang === "en" ? 4 : 5) : (questionLang === "en" ? 6 : 7);
  return TOKEN_SAVER_MODE ? (questionLang === "en" ? 3 : 4) : (questionLang === "en" ? 5 : 6);
}

function pickPromptChunkCharLimit(questionLang: "zh" | "en", analysis: QuestionAnalysis): number {
  if (analysis.conciseAnswer) return questionLang === "en" ? 380 : 320;
  if (analysis.requestDetail) return TOKEN_SAVER_MODE ? (questionLang === "en" ? 560 : 560) : (questionLang === "en" ? 780 : 780);
  if (analysis.expectsFullCoverage) return TOKEN_SAVER_MODE ? (questionLang === "en" ? 500 : 500) : (questionLang === "en" ? 680 : 680);
  return TOKEN_SAVER_MODE ? (questionLang === "en" ? 420 : 420) : (questionLang === "en" ? 600 : 560);
}

function truncatePromptContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return `${content.slice(0, Math.max(0, maxLen)).trim()}\n……`;
}

function preparePromptChunks(
  chunks: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): SearchResult[] {
  const maxChunks = pickPromptChunkBudget(questionLang, analysis);
  const maxChars = pickPromptChunkCharLimit(questionLang, analysis);
  return chunks
    .slice(0, Math.max(1, maxChunks))
    .map((row) => ({
      ...row,
      content: truncatePromptContent(row.content, maxChars),
    }));
}

function pickMainMaxTokens(questionLang: "zh" | "en", analysis: QuestionAnalysis): number {
  if (analysis.conciseAnswer) return questionLang === "en" ? 220 : 260;
  if (analysis.requestDetail) return TOKEN_SAVER_MODE ? (questionLang === "en" ? 520 : 720) : (questionLang === "en" ? 760 : 980);
  if (analysis.expectsFullCoverage) return TOKEN_SAVER_MODE ? (questionLang === "en" ? 430 : 620) : (questionLang === "en" ? 640 : 820);
  return TOKEN_SAVER_MODE ? (questionLang === "en" ? 340 : 500) : (questionLang === "en" ? 520 : 680);
}

export async function generateAnswer(req: QARequest): Promise<QAResponse> {
  const startTime = Date.now();
  const questionLanguage = detectLanguage(req.question);
  const questionAnalysis = detectQuestionIntent(req.question, questionLanguage);
  const materialIds = normalizeMaterialIds(req.materialIds);

  // 检查当前配置是否启用了 RAG 模式
  const activeConfig = await getActiveLlmConfig();
  const useRAG = activeConfig?.useRAG ?? false;

  let mainResult: CallLLMResult;
  let enAnswer: string | undefined;
  let enSources: QuerySource[] | undefined;
  let fromCache = false;

  // 检查缓存
  const cached = getCachedAnswer(req.question, materialIds);
  if (cached) {
    mainResult = cached.mainResult;
    enAnswer = cached.enAnswer;
    enSources = cached.enSources;
    fromCache = true;
  } else {
    // useRAG=true: 关键词+向量混合检索; useRAG=false: 仅关键词检索（两者都搜教材）
    if (questionLanguage === "en") {
      const enResults = await semanticSearch(req.question, materialIds, pickTopK("en", questionAnalysis), "en", useRAG);
      mainResult = await callLLM(req.question, enResults, "en", "en", questionAnalysis, materialIds);
    } else {
      const zhResultsPromise = semanticSearch(req.question, materialIds, pickTopK("zh", questionAnalysis), "zh", useRAG);
      const enResultsPromise = ENABLE_AUX_EN_ANSWER
        ? semanticSearch(req.question, materialIds, pickTopK("en", questionAnalysis, true), "en", useRAG)
        : Promise.resolve([] as SearchResult[]);
      const [zhResults, enResults] = await Promise.all([zhResultsPromise, enResultsPromise]);

      mainResult = await callLLM(req.question, zhResults, "zh", "zh", questionAnalysis, materialIds);

      if (ENABLE_AUX_EN_ANSWER && enResults.length > 0) {
        const enResult = await callLLM(req.question, enResults, "zh", "en", questionAnalysis, materialIds);
        if (enResult.foundInMaterials) {
          enAnswer = enResult.answer;
          enSources = enResult.sources;
        }
      }
    }

    // 只缓存教材中找到内容的答案
    if (mainResult.foundInMaterials) {
      setCachedAnswer(req.question, { mainResult, enAnswer, enSources, questionLanguage }, materialIds);
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
  analysis: QuestionAnalysis = detectQuestionIntent(question, questionLang),
  materialIds?: number[]
): Promise<CallLLMResult> {
  if (searchResults.length === 0) {
    const answer =
      questionLang === "en"
        ? "The provided textbook excerpts do not cover this topic."
        : "教材中未涉及此内容。";

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
    effectiveResults = await enrichDefinitionResults(
      question,
      effectiveResults,
      questionLang,
      analysis,
      materialIds
    );
  }
  const promptChunks = preparePromptChunks(effectiveResults, questionLang, analysis);
  const reviewChunks = promptChunks.length > 0 ? promptChunks : effectiveResults;
  const sourceLimit = pickSourceLimit(questionLang, analysis);
  const materialTitles = Array.from(new Set(effectiveResults.map((r) => r.materialTitle)));

  const systemPrompt = buildSystemPrompt(materialTitles, questionLang, materialLang, analysis);
  const userMessage = buildUserPrompt(question, reviewChunks, questionLang, analysis);

  let llmResponse: { content: string; model: string };
  try {
    llmResponse = await invokeLLMWithConfig(
      [{ role: "user", content: userMessage }],
      systemPrompt,
      {
        temperature: analysis.conciseAnswer ? 0 : undefined,
        maxTokens: pickMainMaxTokens(questionLang, analysis),
      }
    );
  } catch {
    const extractiveFallback =
      buildExtractiveAnswer(question, reviewChunks, questionLang, analysis) ??
      buildEnumerativeExtractiveAnswer(question, reviewChunks, questionLang, analysis);
    if (extractiveFallback) {
      const conciseResults = reviewChunks.filter((r) => extractiveFallback.usedChunkIds.includes(r.chunkId));
      const sources = buildSources(conciseResults, true, keywords, sourceLimit);
      return {
        answer: enforceReadableStructure(extractiveFallback.answer, analysis, questionLang),
        sources,
        modelUsed: "extractive-fallback",
        foundInMaterials: true,
        confidence: 0.62,
      };
    }
    const minimalFallback = buildMinimalGroundedFallback(question, reviewChunks, questionLang, analysis);
    if (minimalFallback) {
      const conciseResults = reviewChunks.filter((r) => minimalFallback.usedChunkIds.includes(r.chunkId));
      const sources = buildSources(conciseResults, true, keywords, sourceLimit);
      return {
        answer: enforceReadableStructure(minimalFallback.answer, analysis, questionLang),
        sources,
        modelUsed: "grounded-lite-fallback",
        foundInMaterials: true,
        confidence: 0.52,
      };
    }

    return {
      answer:
        questionLang === "en"
          ? "The retrieved textbook excerpts are insufficient for a reliable answer right now."
          : "当前检索到的教材片段不足以给出可靠答案。",
      sources: [],
      modelUsed: "fallback-empty",
      foundInMaterials: false,
      confidence: 0.12,
    };
  }

  let answer = stripCitationMarkers(llmResponse.content);

  // 如果 LLM 仍然返回了 JSON，提取 answer 字段
  const parsed = parseLLMOutput(llmResponse.content);
  if (parsed) {
    answer = stripCitationMarkers(parsed.answer);
  }

  if (analysis.conciseAnswer) {
    answer = enforceConciseDefinition(answer, questionLang);
  }
  answer = removeAnswerBoilerplate(answer, questionLang, analysis);
  answer = enforceReadableStructure(answer, analysis, questionLang);

  const localReview = assessAnswerLocally(answer, reviewChunks, analysis, questionLang);
  const grounding = assessGrounding(answer, reviewChunks, questionLang);

  // V2: 统一质量管线（最多 1 次额外 LLM 调用，替代原来的多级串行调用）
  // 决策逻辑：
  //   1. 本地审校通过 + grounding通过 → 直接输出
  //   2. 有质量问题 → 一次性 LLM 质量评估+重写（合并了审校修正、grounding重写、质量门控）
  //   3. 结构化完整且接地通过 → 直接输出
  const compactLen = answer.replace(/\s+/g, "").length;
  const structuredItems = countStructuredItems(answer);
  const skipLLMReview = (localReview.complete && grounding.grounded) ||
    (compactLen > 200 && structuredItems >= 3 && grounding.grounded);
  const severeGroundingIssue = !grounding.grounded && grounding.score < (TOKEN_SAVER_MODE ? 0.5 : 0.62);
  const structureSensitiveIntent =
    analysis.expectsEnumeration || analysis.intent === "method" || analysis.intent === "comparison";
  const englishFastPath =
    TOKEN_SAVER_MODE &&
    questionLang === "en" &&
    grounding.grounded &&
    compactLen >= 180 &&
    !analysis.expectsEnumeration &&
    !analysis.requestDetail;
  const shouldRunQualityEval =
    ENABLE_LLM_QUALITY_REVIEW &&
    !englishFastPath &&
    !skipLLMReview &&
    (
      severeGroundingIssue ||
      (localReview.shouldRetry && structureSensitiveIntent && compactLen < (TOKEN_SAVER_MODE ? (questionLang === "en" ? 900 : 1200) : 1600))
    );

  if (shouldRunQualityEval) {
    // 收集所有问题，一次性交给 LLM 评估+修正
    const allIssues = [...localReview.issues];
    if (!grounding.grounded) {
      allIssues.push(questionLang === "en"
        ? `Answer contains claims not grounded in excerpts (grounding score: ${grounding.score.toFixed(2)}). Rewrite using only excerpt content.`
        : `答案包含教材片段中没有依据的内容（接地分: ${grounding.score.toFixed(2)}），需要严格基于片段重写。`);
    }

    // 先做 LLM 质量评估（判断是否真的需要重写）
    const qualityResult = await evaluateAnswerQuality(
      question, answer, reviewChunks, questionLang, analysis
    );

    const shouldRewrite =
      ENABLE_LLM_REWRITE &&
      (
        severeGroundingIssue ||
        (!qualityResult.pass && qualityResult.score < (TOKEN_SAVER_MODE ? (questionLang === "en" ? 5.6 : 5.9) : 6.5))
      );

    if (shouldRewrite) {
      const combinedFeedback = [
        ...allIssues,
        ...(qualityResult.feedback ? [qualityResult.feedback] : []),
      ].join("; ");

      try {
        const regenerated = await invokeLLMWithConfig(
          [{ role: "user", content: buildQualityRegeneratePrompt(
            question, answer, reviewChunks, questionLang, analysis, combinedFeedback
          ) }],
          buildSystemPrompt(materialTitles, questionLang, materialLang, analysis),
          { temperature: 0, maxTokens: pickMainMaxTokens(questionLang, analysis) }
        );
        const regenParsed = parseLLMOutput(regenerated.content);
        const regenAnswer = stripCitationMarkers(regenParsed ? regenParsed.answer : regenerated.content);
        if (regenAnswer.replace(/\s+/g, "").length >= answer.replace(/\s+/g, "").length * 0.8) {
          answer = enforceReadableStructure(
            removeAnswerBoilerplate(regenAnswer, questionLang, analysis),
            analysis,
            questionLang
          );
        }
      } catch {
        // 重写失败时保留原答案
      }
    }
  }

  const finalReview = assessAnswerLocally(answer, reviewChunks, analysis, questionLang);
  if (!finalReview.complete && shouldAppendDowngradeNote(answer, analysis)) {
    answer = appendDegradationNote(answer, finalReview.downgradeNote);
  }
  answer = removeAnswerBoilerplate(answer, questionLang, analysis);
  answer = enforceReadableStructure(answer, analysis, questionLang);

  // 判断是否在教材中找到了内容
  const notFoundPhrases = ["未涉及", "not cover", "没有相关", "未找到", "not found"];
  const foundInMaterials = !notFoundPhrases.some((p) => answer.toLowerCase().includes(p));

  const sources = buildSources(reviewChunks, foundInMaterials, keywords, sourceLimit);

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

  if (analysis.intent === "definition" && !/(是指|指的是|定义为|定义是|可定义为|meaning|defined as|refers to|means)/i.test(answer)) {
    issues.push("定义题缺少明确的定义表达");
  }

  if (analysis.expectsEnumeration && itemCount < 2) {
    issues.push("分类/方法题的结构化条目过少");
  }

  if (analysis.intent === "comparison" && !hasCompareStructure) {
    issues.push("比较题缺少对比表或分点对比");
  }

  if (analysis.intent === "condition" && !/(条件|要求|前提|时机|时间|时期|when|timing|season|requirement|prerequisite)/i.test(answer)) {
    issues.push("条件/时机题缺少条件性表达");
  }

  if (analysis.expectsFullCoverage && !hasCoveragePhrase && !(questionLang === "en" && compactAnswer.length >= 180)) {
    issues.push("缺少完整性提示或清单式表达");
  }

  if (searchResults.length > 0 && hasNotFoundPhrase && !/教材只明确提到|部分内容|partial/i.test(answer)) {
    const isShortFallbackNote = compactAnswer.length <= 40 && /未涉及|没有相关|未找到|not cover|not found/i.test(answer);
    if (!(analysis.conciseDefinition || analysis.conciseAnswer) || !isShortFallbackNote) {
      issues.push("存在召回片段，但回答仍表现为未涉及");
    }
  }

  const complete = issues.length === 0;
  const downgradeNote =
    questionLang === "en"
      ? "Only items explicitly mentioned in the excerpts are listed."
      : "仅列出教材明确提及的项目。";

  return {
    complete,
    issues,
    shouldRetry: !complete && searchResults.length > 0 && (analysis.conciseDefinition || !analysis.conciseAnswer),
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

type SourceTextBuildOptions = {
  limit?: number;
  maxContentLen?: number;
  includeLocation?: boolean;
  separator?: string;
};

function formatSourceLocation(row: SearchResult): string {
  return [
    `《${row.materialTitle}》`,
    row.chapter ? row.chapter : null,
    row.pageStart ? `第${row.pageStart}页${row.pageEnd && row.pageEnd !== row.pageStart ? `~${row.pageEnd}页` : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function buildSourceTexts(
  searchResults: SearchResult[],
  options: SourceTextBuildOptions = {}
): string {
  const {
    limit,
    maxContentLen,
    includeLocation = true,
    separator = "\n\n---\n\n",
  } = options;

  const rows = typeof limit === "number" ? searchResults.slice(0, Math.max(0, limit)) : searchResults;

  return rows
    .map((row, idx) => {
      const location = includeLocation ? formatSourceLocation(row) : "";
      const content =
        typeof maxContentLen === "number"
          ? row.content.substring(0, Math.max(0, maxContentLen))
          : row.content;
      return includeLocation ? `【片段${idx + 1}】${location}\n${content}` : `【片段${idx + 1}】\n${content}`;
    })
    .join(separator);
}

function buildAnswerReviewPrompt(
  question: string,
  answer: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): string {
  const sourceTexts = buildSourceTexts(searchResults, { maxContentLen: 260 });

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
  const sourceTexts = buildSourceTexts(searchResults);

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
  const sourceTexts = buildSourceTexts(searchResults);

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
  const normalizedAnswer = normalizeForFocus(answer);
  const normalizedNote = normalizeForFocus(note);
  if (normalizedNote && normalizedAnswer.includes(normalizedNote)) return answer;
  return `${answer}\n\n> ${note}`;
}

function shouldAppendDowngradeNote(answer: string, analysis: QuestionAnalysis): boolean {
  if (analysis.conciseAnswer) return false;
  const trimmed = answer.trim();
  if (!trimmed) return false;
  // 只在明显未覆盖语义时追加短注，避免污染正常答案
  return /未涉及|未覆盖|未找到|not cover|not found|partially covered/i.test(trimmed);
}

function removeAnswerBoilerplate(
  answer: string,
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): string {
  const lines = answer.replace(/\r\n/g, "\n").split("\n");
  const filtered: string[] = [];
  const zhDropPatterns = [
    /^#+\s*[一二三四五六七八九十]+[、.．]?\s*概述\s*$/i,
    /^#+\s*[一二三四五六七八九十]+[、.．]?\s*完整性说明\s*$/i,
    /^(?:[一二三四五六七八九十]+[、.．])\s*概述\s*$/,
    /^(?:[一二三四五六七八九十]+[、.．])\s*完整性说明\s*$/,
    /^教材中关于.+?(直接信息|直接定义性信息|最接近的定义性表述|直接相关的要点)[:：]?\s*$/,
    /^教材中明确提到/,
    /^教材中明确提及/,
    /^教材明确将/,
    /^教材中与.+?(直接相关|最接近的定义性表述|直接信息)[:：]?\s*$/,
    /^教材未设专节/,
    /^全部直接源自/,
    /^未作任何扩展或推断/,
    /^教材中唯一出现且可直接提取/,
    /^教材仅明确列出/,
    /^教材未涉及“/,
    /^未使用“/,
    /^未将“/,
    /^可参考教材中的相关表述[:：]?\s*$/,
    /^以下是教材中的相关表述[:：]?\s*$/,
    /^该内容在.*始终与/,
    /^属同一.*维度/,
    /^并非单独列项/,
    /^本回答[:：]?\s*$/,
    /^因此，本回答/,
    /^以上仅列出教材明确出现/,
    /^无任何召回遗漏/,
    /^无任何外部补充/,
    /^仅整理已明确出现的内容/,
    /^仅列出教材明确提及的项目/,
  ];
  const zhDropContains = [
    "教材片段只覆盖了该问题的部分要点",
    "以下仅整理已明确出现的内容",
    "本回答完全限定于教材原文",
    "无任何召回遗漏",
    "无任何外部补充",
    "未作任何扩展或推断",
    "具备可确证性",
    "全部源自教材片段",
    "仅列出教材明确提及的项目",
  ];
  const enDropPatterns = [
    /^#+\s*overview\s*$/i,
    /^#+\s*completeness\s*note\s*$/i,
    /^the textbook explicitly/i,
    /^the excerpts clearly/i,
    /^this answer is strictly limited to/i,
    /^only items explicitly mentioned/i,
    /^excerpt-grounded (definition|information|statement|list).*$/i,
    /^closest excerpt-grounded statement.*$/i,
    /^direct excerpt-grounded (definition|information).*$/i,
  ];
  const enDropContains = [
    "only partially cover this topic",
    "only the clearly stated content is listed",
    "strictly limited to the textbook excerpts",
    "no external supplementation",
    "no inferred content",
  ];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (filtered.length > 0 && filtered[filtered.length - 1] !== "") filtered.push("");
      continue;
    }
    if (line === "-" || line === "*" || line === "•") continue;
    if (/^\[(\d+)\]$/.test(line)) continue;

    const shouldDrop = questionLang === "en"
      ? enDropPatterns.some((re) => re.test(line)) || enDropContains.some((s) => line.toLowerCase().includes(s))
      : zhDropPatterns.some((re) => re.test(line)) || zhDropContains.some((s) => line.includes(s));
    if (shouldDrop) continue;

    if (filtered.length > 0 && normalizeForFocus(filtered[filtered.length - 1]) === normalizeForFocus(line)) {
      continue;
    }
    filtered.push(line);
  }

  let cleaned = filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return answer.trim();

  cleaned = cleaned
    .replace(/(?:^|\n)(?:一、|二、|三、|四、|五、)\s*概述\s*(?=\n|$)/g, "")
    .replace(/(?:^|\n)概述[:：]?\s*(?=\n|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (analysis.expectsEnumeration) {
    cleaned = cleaned
      .replace(/^#+\s*[一二三四五六七八九十]+[、.．]?\s*概述\s*$/gim, "")
      .replace(/^#+\s*overview\s*$/gim, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return cleaned;
}

function enforceReadableStructure(
  answer: string,
  analysis: QuestionAnalysis,
  questionLang: "zh" | "en"
): string {
  if (analysis.conciseAnswer) return answer.trim();
  const trimmed = answer.trim();
  if (!trimmed) return trimmed;

  const lines = trimmed.split("\n");
  const hasHeading = lines.some((line) => /^#{1,3}\s+/.test(line.trim()));
  const bulletLikeCount = lines.filter((line) => /^\s*[-*•]\s+/.test(line)).length;
  const numberedCount = lines.filter((line) => /^\s*\d+[.)、．]\s+/.test(line)).length;

  if (hasHeading) return trimmed;
  if (bulletLikeCount < 3 && numberedCount < 3) return trimmed;

  const titleMapZh: Record<string, string> = {
    classification: "## 关键清单",
    method: "## 实施要点",
    condition: "## 关键条件",
    advantage: "## 要点汇总",
  };
  const titleMapEn: Record<string, string> = {
    classification: "## Key Items",
    method: "## Practical Steps",
    condition: "## Key Requirements",
    advantage: "## Key Points",
  };
  const title =
    questionLang === "en"
      ? (titleMapEn[analysis.intent] ?? "## Key Points")
      : (titleMapZh[analysis.intent] ?? "## 关键要点");

  let idx = 1;
  const normalizedLines = lines.map((line) => {
    if (/^\s*[-*•]\s+/.test(line)) {
      return `${idx++}. ${line.replace(/^\s*[-*•]\s+/, "")}`;
    }
    if (/^\s*\d+[.)、．]\s+/.test(line)) {
      return `${idx++}. ${line.replace(/^\s*\d+[.)、．]\s+/, "")}`;
    }
    return line;
  });

  return `${title}\n\n${normalizedLines.join("\n")}`.replace(/\n{3,}/g, "\n\n").trim();
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
  const sourceTexts = buildSourceTexts(searchResults, {
    limit: analysis.conciseDefinition ? 4 : searchResults.length,
    includeLocation: false,
    separator: "\n\n",
  });
  if (questionLang === "en") {
    return `Rewrite the answer using only information that appears in the excerpts below.
Question: ${question}
Rules:
1. No external knowledge.
2. Paraphrase conservatively; do not add new facts.
3. ${analysis.conciseDefinition ? "Answer in 2-4 sentences only, starting with the direct answer." : "Keep a clear structure based on the question intent, and start directly with the answer."}

Excerpts:
${sourceTexts}`;
  }
  return `请仅基于下方片段重写答案，不得加入片段以外事实。
学生问题：${question}
要求：
1. 只能使用片段中出现的信息，不得发挥。
2. 可适度改写表述，但不能新增事实。
3. 每个事实性陈述后添加引用标记 [1]、[2] 对应片段编号。
4. ${analysis.conciseDefinition ? "这是简洁定义题，仅用2-4句，第一句直接给出定义；禁止历史背景和延伸。" : "按问题类型组织结构，第一句直接进入答案，但不要超出片段。"}

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
  if (!analysis.conciseDefinition && (compactLen < 60 || searchResults.length < 2)) {
    return { pass: true, score: 7, feedback: "" };
  }

  const evalSnippetLimit = TOKEN_SAVER_MODE ? (questionLang === "en" ? 3 : 4) : 6;
  const evalSnippetChars = TOKEN_SAVER_MODE ? (questionLang === "en" ? 120 : 140) : 200;
  const sourceSnippets = searchResults
    .slice(0, evalSnippetLimit)
    .map((r, idx) => `[${idx + 1}] ${r.content.substring(0, evalSnippetChars)}`)
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
      { temperature: 0, maxTokens: TOKEN_SAVER_MODE ? (questionLang === "en" ? 220 : 260) : 300, responseFormat: "json_object" }
    );

    const parsed = parseQualityEvaluation(evalResponse.content);
    if (parsed) {
      return parsed;
    }
  } catch (err: any) {
    void err;
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
  const sourceTexts = buildSourceTexts(searchResults, {
    limit: TOKEN_SAVER_MODE ? (questionLang === "en" ? 4 : 6) : 8,
    maxContentLen: TOKEN_SAVER_MODE ? (questionLang === "en" ? 220 : 320) : 520,
  });

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
    return /\b(is|means|refers to|defined as|is defined as)\b/i.test(text);
  }
  return /(是指|指的是|定义为|定义是|可定义为|即指|系指|即为|通常指|是单位)/.test(text);
}

function hasWeakDefinitionStructure(text: string, questionLang: "zh" | "en"): boolean {
  if (questionLang === "en") {
    return /\b(is|are|means|refers to)\b/i.test(text);
  }
  return /(是指|指的是|定义|含义|概念|即|可称为|称为|是(?:一种|一类|一门|研究|单位|指))/.test(text);
}

function hasHistoricalCue(text: string, questionLang: "zh" | "en"): boolean {
  if (questionLang === "en") {
    return /\b(history|historical|century|in \d{4}|during)\b/i.test(text);
  }
  return /(历史|发展|20世纪|年代|文革|出版|编写|奠基|繁荣)/.test(text);
}

function isDefinitionBoilerplateSentence(sentence: string, questionLang: "zh" | "en"): boolean {
  const s = sentence.trim();
  if (!s) return true;

  const lowered = s.toLowerCase();
  if (/^(复习思考题|思考题|习题|练习题|参考文献|目录|前言|preface|contents|appendix|references)\b/i.test(lowered)) {
    return true;
  }

  if (questionLang === "zh") {
    if (/^\s*[一二三四五六七八九十]+[、．.]\s*$/.test(s)) return true;
    if (/^\s*\d+(?:\.\d+){1,6}\s*$/.test(s)) return true;
    if (/^\s*(?:第[一二三四五六七八九十百千0-9]+[章节篇部分节]|\d+(?:\.\d+){1,6})[：:、.．)]?\s*$/.test(s)) return true;
    if (/^\s*(?:\d+(?:\.\d+){1,6}|[一二三四五六七八九十]+[、．.)])\s*[^。！？]{0,28}$/.test(s)) {
      return true;
    }
  } else {
    if (/^\s*(chapter|section|preface|contents|references|appendix)\b/i.test(s) && s.length <= 80) return true;
    if (/^\s*(\d+(?:\.\d+){1,6}|[ivxlcdm]+[.)])\s*$/i.test(s)) return true;
  }

  return false;
}

function buildDefinitionQueryVariants(question: string, questionLang: "zh" | "en"): string[] {
  const subject = extractDefinitionSubject(question, questionLang);
  if (!subject) return [];

  const variants = new Set<string>([subject]);
  if (questionLang === "en") {
    variants.add(`${subject} definition`);
    variants.add(`${subject} concept`);
    variants.add(`${subject} means`);
    variants.add(`what is ${subject}`);
  } else {
    variants.add(`${subject} 定义`);
    variants.add(`${subject} 概念`);
    variants.add(`${subject} 是指`);
    variants.add(`${subject} 是什么`);
  }

  return uniqueSortedTerms(Array.from(variants)).slice(0, 4);
}

function scoreDefinitionSentence(
  sentence: string,
  question: string,
  questionLang: "zh" | "en",
  subject: string,
  keywords: string[]
): {
  score: number;
  cueHit: boolean;
  subjectHit: boolean;
  directPattern: boolean;
  startsWithSubject: boolean;
} {
  if (isDefinitionBoilerplateSentence(sentence, questionLang)) {
    return {
      score: Number.NEGATIVE_INFINITY,
      cueHit: false,
      subjectHit: false,
      directPattern: false,
      startsWithSubject: false,
    };
  }

  const sentenceNorm = normalizeQuestion(sentence);
  const questionNorm = normalizeQuestion(question);
  const subjectNorm = normalizeQuestion(subject);
  const hasSubject = Boolean(subjectNorm);
  const sentenceHasWeakDef = hasWeakDefinitionStructure(sentence, questionLang);
  const cueHit = hasDefinitionCue(sentence, questionLang);
  const subjectHit = hasSubject && sentenceNorm.includes(subjectNorm);
  const startsWithSubject = hasSubject && sentenceNorm.startsWith(subjectNorm);
      const directPattern = hasSubject
    ? (questionLang === "en"
      ? new RegExp(`^${escapeRegExp(subjectNorm)}.{0,28}(is|means|refersto|definedas|isdefinedas|are)`).test(sentenceNorm)
      : new RegExp(`^${escapeRegExp(subjectNorm)}.{0,18}(是指|指的是|定义为|定义是|可定义为|即指|系指|是一门|是一种|是一类|是研究|是学科|是单位)`).test(sentenceNorm))
    : false;

  let score = 0;
  if (directPattern) score += 16;
  if (cueHit) score += 5;
  if (subjectHit) score += 4;
  if (startsWithSubject) score += 3;
  if (sentenceHasWeakDef) score += 1.5;
  if (questionNorm && sentenceNorm.includes(questionNorm)) score += 1.5;

  for (const kw of keywords) {
    const key = normalizeQuestion(kw);
    if (key && sentenceNorm.includes(key)) score += Math.min(2, key.length * 0.2);
  }

  if (hasHistoricalCue(sentence, questionLang)) score -= 6;
  if (/^\s*(?:第[一二三四五六七八九十百千0-9]+[章节篇部分节]|\d+(?:\.\d+){1,6}|[一二三四五六七八九十]+[、．.)])/.test(sentence)) score -= 5;
  if (sentence.length < (questionLang === "en" ? 12 : 8)) score -= 4;
  if (sentence.length > (questionLang === "en" ? 220 : 140)) score -= 2;

  return {
    score,
    cueHit,
    subjectHit,
    directPattern,
    startsWithSubject,
  };
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
  const subject = extractDefinitionSubject(question, questionLang);
  const subjectNorm = normalizeQuestion(subject);
  if (targets.length === 0) return searchResults;

  const ranked = searchResults
    .map((row) => {
      const text = `${row.chapter || ""}\n${row.content}`;
      const targetHits = targets.filter((term) => text.toLowerCase().includes(term)).length;
      const cue = hasDefinitionCue(row.content, questionLang) ? 1 : 0;
      const history = hasHistoricalCue(text, questionLang) ? 1 : 0;
      const textNorm = normalizeQuestion(text);
      const contentNorm = normalizeQuestion(row.content);
      const subjectHit = Boolean(subjectNorm) && textNorm.includes(subjectNorm);
      const startsWithSubject = Boolean(subjectNorm) && contentNorm.startsWith(subjectNorm);
      const directPattern = subjectNorm
        ? (questionLang === "en"
          ? new RegExp(`^${escapeRegExp(subjectNorm)}.{0,28}(is|means|refersto|definedas|isdefinedas|are)`).test(contentNorm)
          : new RegExp(`^${escapeRegExp(subjectNorm)}.{0,18}(是指|指的是|定义为|定义是|可定义为|即指|系指|是一门|是一种|是一类|是研究|是学科|是单位)`).test(contentNorm))
        : false;
      const score =
        row.similarity * 2.0 +
        targetHits * 1.2 +
        (cue > 0 ? 2.5 : 0) +
        (subjectHit ? 4.0 : 0) +
        (startsWithSubject ? 3.0 : 0) +
        (directPattern ? 7.0 : 0) -
        history * 2.0;
      return { row, score, cue, targetHits, subjectHit, directPattern };
    })
    .sort((a, b) => b.score - a.score);

  const strong = ranked.filter((item) => item.directPattern || (item.cue > 0 && item.subjectHit));
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
  analysis: QuestionAnalysis,
  materialIds?: number[]
): Promise<SearchResult[]> {
  if (!analysis.conciseDefinition || searchResults.length === 0) return searchResults;

  const queryVariants = buildDefinitionQueryVariants(question, questionLang);
  if (queryVariants.length === 0) return searchResults;

  try {
    const extraBatches = await Promise.all(
      queryVariants.map((variant) =>
        semanticSearch(
          variant,
          materialIds,
          Math.max(6, pickTopK(questionLang, analysis) + 2),
          questionLang,
          false
        ).catch(() => [] as SearchResult[])
      )
    );
    const extraResults = extraBatches.flat();
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
  const subject = extractDefinitionSubject(question, questionLang);
  const subjectNorm = normalizeQuestion(subject);
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
  const strictScored: Array<{ sentence: string; score: number; chunkId: number }> = [];
  const fallbackScored: Array<{ sentence: string; score: number; chunkId: number }> = [];
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
    if (/^(目录|前言|附录)$/i.test(s)) return true;
    if (/^\d+[.)、．]\s*$/.test(s)) return true;
    if (/^[一二三四五六七八九十]+[、．.]\s*$/.test(s)) return true;
    if (/^\s*\d+(?:\.\d+){1,6}\s*[^。！？]{0,56}$/.test(s)) {
      return true;
    }
    if (/^\s*(?:第[一二三四五六七八九十百千0-9]+[章节篇部分节]|\d+(?:\.\d+){1,6})[：:、.．)]?\s*[^。！？]{0,40}$/.test(s)) {
      return true;
    }
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
      if (analysis.conciseDefinition) {
        const sentenceScore = scoreDefinitionSentence(sentence, question, questionLang, subject, keywords);
        if (!Number.isFinite(sentenceScore.score) || sentenceScore.score <= 0) continue;

        const targetHit = definitionTargets.some((term) => sentence.toLowerCase().includes(term));
        const strictHit =
          sentenceScore.directPattern ||
          (sentenceScore.cueHit && sentenceScore.subjectHit && sentenceScore.startsWithSubject);
        const baseScore = sentenceScore.score + (targetHit ? 1.5 : 0);
        const weakStructureHit = hasWeakDefinitionStructure(sentence, questionLang);

        if (strictHit) {
          strictScored.push({ sentence, score: baseScore + 4, chunkId: chunk.chunkId });
        } else if (sentenceScore.subjectHit && sentenceScore.startsWithSubject && weakStructureHit) {
          fallbackScored.push({
            sentence,
            score:
              baseScore +
              (sentenceScore.startsWithSubject ? 1.5 : 0) +
              (subjectNorm && sNorm.includes(subjectNorm) ? 1 : 0) +
              (targetHit ? 0.8 : 0),
            chunkId: chunk.chunkId,
          });
        }
        continue;
      }

      let score = 0;
      if (queryNorm && sNorm.includes(queryNorm)) score += 8;
      for (const kw of keywords) {
        if (sNorm.includes(normalizeQuestion(kw))) score += Math.min(4, kw.length);
      }
      if (score > 0) scored.push({ sentence, score, chunkId: chunk.chunkId });
    }
  }

  const definitionPool = strictScored.length > 0
    ? strictScored.sort((a, b) => b.score - a.score)
    : fallbackScored.sort((a, b) => b.score - a.score).filter((item) => item.score >= 10);
  if (analysis.conciseDefinition && definitionPool.length === 0) return null;
  if (!analysis.conciseDefinition && scored.length === 0) return null;

  const rankedPool = analysis.conciseDefinition ? definitionPool : scored.sort((a, b) => b.score - a.score);
  const used = new Set<number>();
  const picked: Array<{ sentence: string; chunkId: number }> = [];
  const seen = new Set<string>();
  const maxItems = analysis.conciseDefinition ? 2 : analysis.conciseAnswer ? 3 : 5;

  for (const item of rankedPool) {
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
    return `- ${trimmed}${/[。！？…]$/.test(trimmed) ? "" : "。"}`;
  });
  const answerBody = analysis.conciseDefinition
    ? lines.map((line) => line.replace(/^-\s*/, "")).join(questionLang === "en" ? " " : "\n").trim()
    : lines.join("\n").trim();

  return {
    answer: answerBody,
    usedChunkIds: Array.from(used),
  };
}

function buildMinimalGroundedFallback(
  question: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): { answer: string; usedChunkIds: number[] } | null {
  if (searchResults.length === 0) return null;

  const keywords = (questionLang === "en" ? extractKeywordsEn(question) : extractKeywords(question)).slice(0, 8);
  const maxCandidates = analysis.conciseAnswer ? 2 : analysis.expectsEnumeration ? 4 : 3;
  const candidates: Array<{ text: string; chunkId: number }> = [];
  const seen = new Set<string>();

  for (const chunk of searchResults.slice(0, Math.max(3, maxCandidates + 1))) {
    let sentence = extractHighlightSentence(chunk.content, keywords)
      .replace(/\s+/g, " ")
      .trim();
    if (!sentence) continue;
    if (sentence.length < (questionLang === "en" ? 18 : 8)) continue;
    if (analysis.conciseDefinition && !hasWeakDefinitionStructure(sentence, questionLang) && !hasDefinitionCue(sentence, questionLang)) {
      continue;
    }

    sentence = truncateSentenceSmart(sentence, questionLang, questionLang === "en" ? 170 : 96);
    const key = normalizeQuestion(sentence).slice(0, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ text: sentence, chunkId: chunk.chunkId });
    if (candidates.length >= maxCandidates) break;
  }

  if (candidates.length === 0) return null;

  const citationMap = new Map<number, number>();
  const usedChunkIds: number[] = [];
  for (const item of candidates) {
    if (!citationMap.has(item.chunkId)) {
      citationMap.set(item.chunkId, citationMap.size + 1);
      usedChunkIds.push(item.chunkId);
    }
  }

  if (analysis.conciseDefinition) {
    const text = candidates
      .slice(0, 2)
      .map((item) => {
        const cite = citationMap.get(item.chunkId)!;
        const ending = questionLang === "en" ? /[.!?…]$/.test(item.text) : /[。！？…]$/.test(item.text);
        return `${item.text}${ending ? "" : questionLang === "en" ? "." : "。"} [${cite}]`;
      })
      .join(questionLang === "en" ? " " : "\n");
    return { answer: text.trim(), usedChunkIds };
  }

  const lines = candidates.map((item, idx) => {
    const cite = citationMap.get(item.chunkId)!;
    const ending = questionLang === "en" ? /[.!?…]$/.test(item.text) : /[。！？…]$/.test(item.text);
    const content = `${item.text}${ending ? "" : questionLang === "en" ? "." : "。"} [${cite}]`;
    return analysis.expectsEnumeration ? `${idx + 1}. ${content}` : `- ${content}`;
  });

  return {
    answer: lines.join("\n"),
    usedChunkIds,
  };
}

function buildEnumerativeExtractiveAnswer(
  question: string,
  searchResults: SearchResult[],
  questionLang: "zh" | "en",
  analysis: QuestionAnalysis
): { answer: string; usedChunkIds: number[] } | null {
  const enableEnumExtractive = process.env.ENABLE_ENUM_EXTRACTIVE !== "false";
  if (!enableEnumExtractive) return null;
  if (!analysis.expectsEnumeration || analysis.requestDetail || analysis.intent === "method") return null;
  if (searchResults.length === 0) return null;

  const keywords = (questionLang === "en" ? extractKeywordsEn(question) : extractKeywords(question))
    .filter((k) => k.length >= 2)
    .slice(0, 10);
  const queryNorm = normalizeQuestion(question);
  const splitter = questionLang === "en" ? /[.!?\n]/ : /[。！？\n]/;
  const cuePattern = questionLang === "en"
    ? /\b(include|including|types|methods|steps|indicators?|requirements?|conditions?|forms?)\b/i
    : /(包括|主要有|可分为|分为|指标|类型|方法|步骤|条件|要求|表现形式|功能|作用)/;
  const metaPattern = questionLang === "en"
    ? /\b(textbook|chapter|this answer|not directly listed|inferred)\b/i
    : /(教材|本章|本节|本回答|未直接|推断|梳理|框架)/;

  const picked: Array<{ sentence: string; score: number; chunkId: number }> = [];

  for (const row of searchResults.slice(0, Math.max(6, pickTopK(questionLang, analysis)))) {
    const sentences = row.content
      .split(splitter)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((s) => s.length >= (questionLang === "en" ? 16 : 8));

    for (const sentence of sentences) {
      const sNorm = normalizeQuestion(sentence);
      let score = 0;
      if (queryNorm && sNorm.includes(queryNorm)) score += 3.5;
      for (const kw of keywords) {
        const key = normalizeQuestion(kw);
        if (!key) continue;
        if (sNorm.includes(key)) score += Math.min(2.8, key.length * 0.45);
      }
      if (cuePattern.test(sentence)) score += 2.2;
      if (metaPattern.test(sentence)) score -= 2.6;
      if (sentence.length > (questionLang === "en" ? 220 : 140)) score -= 1.2;
      if (/[:：]/.test(sentence)) score += 0.7;

      if (score >= 3.0) {
        picked.push({ sentence, score, chunkId: row.chunkId });
      }
    }
  }

  if (picked.length === 0) return null;

  picked.sort((a, b) => b.score - a.score);
  const dedup: Array<{ sentence: string; chunkId: number }> = [];
  const used = new Set<number>();
  const seen = new Set<string>();
  const maxItems = questionLang === "en" ? 6 : 7;

  for (const item of picked) {
    const key = normalizeQuestion(item.sentence).slice(0, 100);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push({ sentence: item.sentence, chunkId: item.chunkId });
    used.add(item.chunkId);
    if (dedup.length >= maxItems) break;
  }

  if (dedup.length < 3) return null;

  const lines = dedup.map((item) => {
    const t = truncateSentenceSmart(item.sentence, questionLang, questionLang === "en" ? 180 : 96);
    if (questionLang === "en") return `- ${t}${/[.!?…]$/.test(t) ? "" : "."}`;
    return `- ${t}${/[。！？…]$/.test(t) ? "" : "。"}`;
  });

  return {
    answer: lines.join("\n"),
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
 * 质量优先的流式接口：
 * 复用与非流式一致的答案生成与审校管线，待最终答案确定后再输出。
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
  const materialIds = normalizeMaterialIds(req.materialIds);

  try {
    const cached = getCachedAnswer(req.question, materialIds);
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
      onToken(cached.mainResult.answer);
      onDone(cached.mainResult.answer);
      return;
    }

    const langFilter = questionLanguage === "en" ? "en" : "zh";
    const topK = questionLanguage === "en" ? pickTopK("en", questionAnalysis) : pickTopK("zh", questionAnalysis);
    let searchResults: SearchResult[] = await semanticSearch(req.question, materialIds, topK, langFilter, useRAG);

    // useRAG=false 且首次未命中时，允许尝试 embedding 检索兜底
    if (searchResults.length === 0 && !useRAG && activeConfig?.embeddingModel) {
      searchResults = await semanticSearch(req.question, materialIds, topK, langFilter, true);
    }

    const mainResult = await callLLM(
      req.question,
      searchResults,
      questionLanguage,
      questionLanguage,
      questionAnalysis,
      materialIds
    );

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

    onMeta({
      sources: mainResult.sources,
      modelUsed: mainResult.modelUsed,
      foundInMaterials: mainResult.foundInMaterials,
      confidence: mainResult.confidence,
      questionLanguage,
      queryId,
      responseTimeMs,
    });

    if (mainResult.foundInMaterials) {
      setCachedAnswer(req.question, { mainResult, questionLanguage }, materialIds);
    }

    const today = new Date().toISOString().split("T")[0];
    const cityDist = req.visitorCity ? { [req.visitorCity]: 1 } : {};
    const countryDist = req.visitorCountry ? { [req.visitorCountry]: 1 } : {};
    upsertVisitorStat(today, cityDist, countryDist).catch(console.error);

    onToken(mainResult.answer);
    onDone(mainResult.answer);
  } catch (err: any) {
    onError(err?.message || String(err));
  }
}
