/**
 * 问答生成服务（v2 — 集成 CODEX 改进）
 * 流程：问题向量化 → 语义检索 Top-5 → 构建结构化上下文 → LLM 生成 JSON 答案 → 解析引用 → 标注来源
 */
import { semanticSearch, type SearchResult } from "./vectorSearch";
import { invokeLLMWithConfig } from "./llmDriver";
import { createQuery, upsertVisitorStat } from "./db";
import type { QuerySource } from "../drizzle/schema";

// ─── 问答请求类型 ─────────────────────────────────────────────────────────────
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
  confidence?: number;
};

// ─── LLM 结构化输出类型 ───────────────────────────────────────────────────────
type LLMStructuredOutput = {
  answer: string;
  found_in_materials: boolean;
  citation_indices: number[];
  confidence: number;
};

// ─── 构建 System Prompt（严格基于教材，7 条约束）────────────────────────────
export function buildSystemPrompt(materialTitles: string[]): string {
  const titleList = materialTitles.length > 0
    ? materialTitles.map((t, i) => `  ${i + 1}. 《${t}》`).join("\n")
    : "  （暂无已发布教材）";

  return `你是北京林业大学森林培育学科的专业教学助手，严格基于以下教材内容回答学生问题：
${titleList}

【七条核心约束，必须严格遵守】
1. 【仅基于教材】你的回答必须完全来自下方【教材内容】，禁止引入任何教材以外的知识、数据或观点。
2. 【原文优先】对于教材中有原文表述的内容，必须直接引用原文，保持与教材完全一致的表述，不得改写或意译。
3. 【多观点全列】如果教材中涉及多个定义、观点或分类，必须逐一列举全部，不得遗漏任何一条。
4. 【未涉及声明】如果问题在所提供的教材片段中完全找不到相关内容，必须回答："教材中未涉及此内容。建议查阅其他章节或咨询教师。"
5. 【禁止自由发挥】禁止编造数据、引用不存在的研究、添加教材以外的补充说明，或使用"根据我的知识"等表述。
6. 【学术中文风格】使用规范的学术中文，保持客观严谨，专业术语与教材保持一致。
7. 【结构化输出】必须以 JSON 格式返回，字段如下：
   - answer: 字符串，完整的回答内容（Markdown 格式）
   - found_in_materials: 布尔值，是否在教材中找到相关内容
   - citation_indices: 整数数组，回答中引用了哪些片段（从 1 开始编号）
   - confidence: 0.0~1.0 的浮点数，回答与教材的匹配置信度

【回答格式要求】
- answer 字段使用 Markdown，重要概念加粗，多要点用编号列表
- 不在 answer 中重复说明引用来源（系统会自动标注）
- 只输出 JSON，不要有任何前缀或后缀文字`;
}

// ─── 构建用户 Prompt（含编号引用片段）───────────────────────────────────────
export function buildUserPrompt(question: string, chunks: SearchResult[]): string {
  const chunkTexts = chunks
    .map((r, idx) => {
      const location = [
        `《${r.materialTitle}》`,
        r.chapter ? r.chapter : null,
        r.pageStart ? `第${r.pageStart}页${r.pageEnd && r.pageEnd !== r.pageStart ? `~${r.pageEnd}页` : ""}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      return `[引用${idx + 1}] 来源：${location}
${r.content}`;
    })
    .join("\n\n---\n\n");

  return `【学生问题】
${question}

【教材内容片段（共 ${chunks.length} 条，请严格基于这些内容回答）】
${chunkTexts}

请根据以上教材内容，以 JSON 格式回答学生的问题。`;
}

// ─── 主问答函数 ───────────────────────────────────────────────────────────────
export async function generateAnswer(req: QARequest): Promise<QAResponse> {
  const startTime = Date.now();

  // 1. 语义检索相关教材片段
  const searchResults = await semanticSearch(req.question, 5);

  let answer: string;
  let modelUsed = "built-in";
  let foundInMaterials = false;
  let confidence = 0;
  let usedSources: SearchResult[] = [];

  if (searchResults.length === 0) {
    answer = "教材中未涉及此内容。建议查阅其他章节或咨询教师。";
    foundInMaterials = false;
  } else {
    // 2. 构建 System Prompt（含教材标题列表）
    const materialTitles = Array.from(new Set(searchResults.map((r) => r.materialTitle)));
    const systemPrompt = buildSystemPrompt(materialTitles);

    // 3. 构建用户 Prompt（含编号引用片段）
    const userMessage = buildUserPrompt(req.question, searchResults);

    // 4. 调用 LLM 生成结构化 JSON 答案
    const llmResponse = await invokeLLMWithConfig(
      [{ role: "user", content: userMessage }],
      systemPrompt
    );

    modelUsed = llmResponse.model;

    // 5. 解析 LLM JSON 输出
    const parsed = parseLLMOutput(llmResponse.content);

    if (parsed) {
      answer = parsed.answer;
      foundInMaterials = parsed.found_in_materials;
      confidence = parsed.confidence;

      // 根据 citation_indices 映射到实际 sources
      if (parsed.citation_indices && parsed.citation_indices.length > 0) {
        usedSources = parsed.citation_indices
          .filter((idx) => idx >= 1 && idx <= searchResults.length)
          .map((idx) => searchResults[idx - 1]);
        // 去重
        usedSources = usedSources.filter(
          (s, i, arr) => arr.findIndex((x) => x.chunkId === s.chunkId) === i
        );
      } else {
        // 如果没有指定引用，使用全部检索结果
        usedSources = searchResults;
      }

      // 如果 found_in_materials=false 但 answer 中没有标准提示，自动补上
      if (!foundInMaterials && !answer.includes("教材中未涉及")) {
        answer = "教材中未涉及此内容。建议查阅其他章节或咨询教师。";
        usedSources = [];
      }
    } else {
      // JSON 解析失败，使用原始内容
      answer = llmResponse.content;
      foundInMaterials = true;
      usedSources = searchResults;
    }
  }

  const responseTimeMs = Date.now() - startTime;

  // 6. 构建引用来源（包含教材名、章节、页码、原文摘录）
  const sources: QuerySource[] = usedSources.map((r) => ({
    materialId: r.materialId,
    materialTitle: r.materialTitle,
    chapter: r.chapter,
    pageStart: r.pageStart,
    pageEnd: r.pageEnd,
    excerpt: r.content.substring(0, 200) + (r.content.length > 200 ? "..." : ""),
  }));

  // 7. 记录查询到数据库
  const queryId = await createQuery({
    question: req.question,
    answer,
    sources,
    modelUsed,
    responseTimeMs,
    visitorIp: req.visitorIp,
    visitorCity: req.visitorCity,
    visitorRegion: req.visitorRegion,
    visitorCountry: req.visitorCountry,
    visitorLat: req.visitorLat,
    visitorLng: req.visitorLng,
  });

  // 8. 更新访客统计（异步，不阻塞响应）
  const today = new Date().toISOString().split("T")[0];
  const cityDist = req.visitorCity ? { [req.visitorCity]: 1 } : {};
  const countryDist = req.visitorCountry ? { [req.visitorCountry]: 1 } : {};
  upsertVisitorStat(today, cityDist, countryDist).catch(console.error);

  return { answer, sources, modelUsed, responseTimeMs, queryId, foundInMaterials, confidence };
}

// ─── 解析 LLM JSON 输出 ───────────────────────────────────────────────────────
function parseLLMOutput(content: string): LLMStructuredOutput | null {
  try {
    // 尝试直接解析
    const parsed = JSON.parse(content.trim());
    if (isValidStructuredOutput(parsed)) return parsed;
  } catch {
    // 尝试提取 JSON 代码块
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        if (isValidStructuredOutput(parsed)) return parsed;
      } catch {
        // 继续尝试
      }
    }

    // 尝试提取裸 JSON 对象
    const objectMatch = content.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        if (isValidStructuredOutput(parsed)) return parsed;
      } catch {
        // 解析失败
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
