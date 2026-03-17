/**
 * 问答生成服务
 * 流程：问题向量化 → Milvus/向量检索 Top-5 → 构建上下文 → LLM 生成答案 → 标注引用
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
};

// ─── System Prompt（严格基于教材回答）────────────────────────────────────────
const SYSTEM_PROMPT = `你是一位专业的森林培育学教学助手，基于提供的教材内容回答学生问题。

【核心规则】
1. 你的回答必须严格基于下方提供的【教材内容】，不得自由发挥或添加教材中未提及的内容。
2. 对于教材中有原文的内容，优先直接引用原文，保持与教材一致的表述。
3. 如果教材中涉及多个观点或定义，必须列举所有相关观点，不得遗漏。
4. 如果问题涉及的内容在所提供的教材片段中未找到，明确回复："根据现有教材内容，暂未找到关于此问题的相关内容。建议查阅其他章节或咨询教师。"
5. 禁止编造数据、引用不存在的研究或添加教材以外的信息。

【回答格式】
- 使用清晰的段落结构，重要概念加粗
- 如有多个要点，使用编号列表
- 专业术语保持与教材一致
- 回答结束后，不需要额外说明引用来源（系统会自动标注）

【语言要求】
- 使用规范的学术中文
- 保持客观、严谨的学术风格`;

// ─── 主问答函数 ───────────────────────────────────────────────────────────────
export async function generateAnswer(req: QARequest): Promise<QAResponse> {
  const startTime = Date.now();

  // 1. 语义检索相关教材片段
  const searchResults = await semanticSearch(req.question, 5);

  let answer: string;
  let modelUsed = "built-in";

  if (searchResults.length === 0) {
    answer = "根据现有教材内容，暂未找到关于此问题的相关内容。建议查阅其他章节或咨询教师。";
  } else {
    // 2. 构建上下文
    const context = buildContext(searchResults);

    // 3. 构建用户消息
    const userMessage = `【学生问题】
${req.question}

【相关教材内容】
${context}

请根据以上教材内容回答学生的问题。`;

    // 4. 调用 LLM 生成答案
    const llmResponse = await invokeLLMWithConfig(
      [{ role: "user", content: userMessage }],
      SYSTEM_PROMPT
    );

    answer = llmResponse.content;
    modelUsed = llmResponse.model;
  }

  const responseTimeMs = Date.now() - startTime;

  // 5. 构建引用来源
  const sources: QuerySource[] = searchResults.map((r) => ({
    materialId: r.materialId,
    materialTitle: r.materialTitle,
    chapter: r.chapter,
    pageStart: r.pageStart,
    pageEnd: r.pageEnd,
    excerpt: r.content.substring(0, 200) + (r.content.length > 200 ? "..." : ""),
  }));

  // 6. 记录查询到数据库
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

  // 7. 更新访客统计（异步，不阻塞响应）
  const today = new Date().toISOString().split("T")[0];
  const cityDist = req.visitorCity ? { [req.visitorCity]: 1 } : {};
  const countryDist = req.visitorCountry ? { [req.visitorCountry]: 1 } : {};
  upsertVisitorStat(today, cityDist, countryDist).catch(console.error);

  return { answer, sources, modelUsed, responseTimeMs, queryId };
}

// ─── 构建 LLM 上下文 ──────────────────────────────────────────────────────────
function buildContext(results: SearchResult[]): string {
  return results
    .map((r, idx) => {
      const location = [
        r.materialTitle,
        r.chapter ? `${r.chapter}` : null,
        r.pageStart ? `第${r.pageStart}页` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      return `【片段${idx + 1}】来源：${location}
${r.content}`;
    })
    .join("\n\n---\n\n");
}
