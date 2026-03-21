#!/usr/bin/env npx tsx
/**
 * 森林培育学 QA 系统自动评测脚本
 *
 * 使用方式：
 *   1. 确保本地 QA 系统已启动 (npm run dev)
 *   2. npx tsx scripts/eval-qa.ts                     # 从数据库自动生成题目并测试
 *   3. npx tsx scripts/eval-qa.ts --count 100         # 只测 100 题
 *   4. npx tsx scripts/eval-qa.ts --chapter "第三章"   # 只测某章
 *   5. npx tsx scripts/eval-qa.ts --dry-run           # 只生成题目不调用 API
 *
 * 评测指标：
 *   - 引用覆盖率：回答中 [1][2] 标记数量 / 提供的源数量
 *   - Grounding 分数：回答关键词与教材片段的重叠度
 *   - 答案长度：太短(<100字)扣分，适中最优
 *   - 结构完整性：是否有标题、列表、加粗等 Markdown 结构
 *   - 响应时间：单位毫秒
 */

import mysql from "mysql2/promise";

// ─── 配置 ──────────────────────────────────────────────────────────────────────
const API_BASE = process.env.EVAL_API_BASE || "http://localhost:3000";
const CONCURRENCY = parseInt(process.env.EVAL_CONCURRENCY || "3", 10);
const TIMEOUT_MS = parseInt(process.env.EVAL_TIMEOUT || "120000", 10);

// ─── 命令行参数解析 ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const MAX_QUESTIONS = parseInt(getArg("count") || "1000", 10);
const CHAPTER_FILTER = getArg("chapter") || "";
const DRY_RUN = hasFlag("dry-run");
const VERBOSE = hasFlag("verbose");

// ─── 题型模板 ──────────────────────────────────────────────────────────────────
type QuestionTemplate = {
  intent: string;
  make: (topic: string) => string;
};

const TEMPLATES: QuestionTemplate[] = [
  { intent: "definition", make: (t) => `什么是${t}？` },
  { intent: "definition", make: (t) => `请解释${t}的概念` },
  { intent: "classification", make: (t) => `${t}有哪些类型？` },
  { intent: "classification", make: (t) => `${t}包括哪些？` },
  { intent: "method", make: (t) => `${t}的方法有哪些？` },
  { intent: "method", make: (t) => `如何进行${t}？` },
  { intent: "method", make: (t) => `${t}的步骤是什么？` },
  { intent: "condition", make: (t) => `${t}需要满足哪些条件？` },
  { intent: "advantage", make: (t) => `${t}的优缺点是什么？` },
  { intent: "comparison", make: (t) => `${t}之间有什么区别？` },
  { intent: "other", make: (t) => `${t}在实际生产中有什么意义？` },
  { intent: "other", make: (t) => `${t}的基本原则是什么？` },
  { intent: "other", make: (t) => `请详细论述${t}` },
];

// ─── 从数据库提取教材关键主题 ──────────────────────────────────────────────────
type TopicInfo = {
  topic: string;
  chapter: string;
  materialTitle: string;
};

async function extractTopicsFromDB(): Promise<TopicInfo[]> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("❌ 未设置 DATABASE_URL 环境变量");
    console.error("   请在 .env 文件中配置，或使用：");
    console.error("   DATABASE_URL=mysql://user:pass@host:3306/db npx tsx scripts/eval-qa.ts");
    process.exit(1);
  }

  console.log("📖 从数据库读取教材内容...");
  const conn = await mysql.createConnection(dbUrl);

  try {
    // 获取所有已发布教材的章节
    const [chapters] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT DISTINCT mc.chapter, m.title AS materialTitle
      FROM material_chunks mc
      JOIN materials m ON mc.materialId = m.id
      WHERE m.status = 'published' AND mc.chapter IS NOT NULL
      ORDER BY m.id, mc.chunkIndex
    `);

    if (chapters.length === 0) {
      console.error("❌ 数据库中没有已发布的教材。请先上传教材。");
      process.exit(1);
    }

    console.log(`   找到 ${chapters.length} 个章节`);

    // 从每个章节的内容中提取关键术语
    const [chunks] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT mc.content, mc.chapter, m.title AS materialTitle
      FROM material_chunks mc
      JOIN materials m ON mc.materialId = m.id
      WHERE m.status = 'published'
      ORDER BY m.id, mc.chunkIndex
    `);

    console.log(`   读取了 ${chunks.length} 个文本块`);

    // 提取关键术语：从教材内容中找 **加粗** 的术语和章节标题中的关键词
    const topicSet = new Map<string, TopicInfo>();

    // 1. 从章节标题提取
    for (const row of chapters) {
      const ch = row.chapter as string;
      const title = row.materialTitle as string;
      // 清理章节号，提取核心概念
      const cleaned = ch
        .replace(/^第[一二三四五六七八九十百千万\d]+[章节篇][\s、：:]*/, "")
        .replace(/^[\d.]+\s*/, "")
        .trim();
      if (cleaned.length >= 2 && cleaned.length <= 20) {
        topicSet.set(cleaned, { topic: cleaned, chapter: ch, materialTitle: title });
      }
    }

    // 2. 从教材加粗内容提取
    for (const row of chunks) {
      const content = row.content as string;
      const ch = (row.chapter as string) || "未知章节";
      const title = row.materialTitle as string;

      // 匹配 **加粗** 标记的术语
      const boldMatches = content.matchAll(/\*\*([^*]{2,20})\*\*/g);
      for (const m of boldMatches) {
        const term = m[1].trim();
        if (term.length >= 2 && !topicSet.has(term) && !/^\d+$/.test(term)) {
          topicSet.set(term, { topic: term, chapter: ch, materialTitle: title });
        }
      }

      // 匹配"X是指..."、"所谓X"等定义模式
      const defMatches = content.matchAll(/(?:所谓|)([\u4e00-\u9fff]{2,10})(?:是指|指的是|即|就是|，是)/g);
      for (const m of defMatches) {
        const term = m[1].trim();
        if (term.length >= 2 && !topicSet.has(term) && !/^[是的了在有]/.test(term)) {
          topicSet.set(term, { topic: term, chapter: ch, materialTitle: title });
        }
      }
    }

    const topics = Array.from(topicSet.values());
    console.log(`   提取了 ${topics.length} 个关键术语`);
    return topics;
  } finally {
    await conn.end();
  }
}

// ─── 生成测试题 ────────────────────────────────────────────────────────────────
type TestQuestion = {
  id: number;
  question: string;
  chapter: string;
  intent: string;
  topic: string;
};

function generateQuestions(topics: TopicInfo[], maxCount: number): TestQuestion[] {
  const questions: TestQuestion[] = [];
  let id = 1;

  // 打乱主题顺序
  const shuffled = [...topics].sort(() => Math.random() - 0.5);

  for (const topicInfo of shuffled) {
    if (questions.length >= maxCount) break;

    // 如果有章节过滤
    if (CHAPTER_FILTER && !topicInfo.chapter.includes(CHAPTER_FILTER)) continue;

    // 随机选 2-3 个模板
    const templateCount = 2 + Math.floor(Math.random() * 2);
    const shuffledTemplates = [...TEMPLATES].sort(() => Math.random() - 0.5).slice(0, templateCount);

    for (const tpl of shuffledTemplates) {
      if (questions.length >= maxCount) break;
      questions.push({
        id: id++,
        question: tpl.make(topicInfo.topic),
        chapter: topicInfo.chapter,
        intent: tpl.intent,
        topic: topicInfo.topic,
      });
    }
  }

  return questions;
}

// ─── 调用 QA API ──────────────────────────────────────────────────────────────
type QAResult = {
  answer: string;
  sources: { materialTitle: string; chapter: string | null; excerpt: string }[];
  modelUsed: string;
  responseTimeMs: number;
  foundInMaterials: boolean;
  confidence: number;
  error?: string;
};

async function askQuestion(question: string): Promise<QAResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // 使用非流式 tRPC 端点
    const resp = await fetch(`${API_BASE}/api/trpc/qa.ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: { question } }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        answer: "",
        sources: [],
        modelUsed: "unknown",
        responseTimeMs: 0,
        foundInMaterials: false,
        confidence: 0,
        error: `HTTP ${resp.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = await resp.json();
    const result = data.result?.data?.json || data.result?.data || data;

    return {
      answer: result.answer || "",
      sources: result.sources || [],
      modelUsed: result.modelUsed || "unknown",
      responseTimeMs: result.responseTimeMs || 0,
      foundInMaterials: result.foundInMaterials ?? false,
      confidence: result.confidence ?? 0,
    };
  } catch (err: any) {
    return {
      answer: "",
      sources: [],
      modelUsed: "unknown",
      responseTimeMs: 0,
      foundInMaterials: false,
      confidence: 0,
      error: err.name === "AbortError" ? "超时" : err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── 评分函数 ──────────────────────────────────────────────────────────────────
type ScoreResult = {
  citationCoverage: number;   // 0-1: 引用标记数 / 源数量
  citationCount: number;      // [N] 标记数量
  groundingScore: number;     // 0-1: 关键词重叠度
  lengthScore: number;        // 0-1: 答案长度评分
  structureScore: number;     // 0-1: 结构完整性
  overallScore: number;       // 加权综合分 (0-100)
  answerLength: number;       // 字符数
  issues: string[];           // 扣分原因
};

function scoreAnswer(answer: string, sources: { excerpt: string }[], question: string): ScoreResult {
  const issues: string[] = [];

  // 1. 引用覆盖率
  const citationMatches = answer.match(/\[(\d+)\]/g) || [];
  const uniqueCitations = new Set(citationMatches.map((m) => m.replace(/[\[\]]/g, "")));
  const citationCount = uniqueCitations.size;
  const sourceCount = Math.max(sources.length, 1);
  const citationCoverage = Math.min(citationCount / sourceCount, 1);
  if (citationCount === 0) issues.push("无引用标记 [N]");
  else if (citationCoverage < 0.3) issues.push("引用覆盖率低");

  // 2. Grounding 分数 (关键词重叠)
  const sourceText = sources.map((s) => s.excerpt).join(" ");
  const sourceKeywords = extractChineseKeywords(sourceText);
  const answerKeywords = extractChineseKeywords(answer);
  const overlap = answerKeywords.filter((k) => sourceKeywords.has(k));
  const groundingScore = answerKeywords.length > 0
    ? Math.min(overlap.length / answerKeywords.length, 1)
    : 0;
  if (groundingScore < 0.3) issues.push("答案与教材关键词重叠低");

  // 3. 答案长度评分
  const answerLength = answer.length;
  let lengthScore: number;
  if (answerLength < 50) {
    lengthScore = 0.2;
    issues.push("答案太短(<50字)");
  } else if (answerLength < 100) {
    lengthScore = 0.5;
    issues.push("答案偏短(<100字)");
  } else if (answerLength < 200) {
    lengthScore = 0.7;
  } else if (answerLength <= 2000) {
    lengthScore = 1.0;
  } else {
    lengthScore = 0.8;
    issues.push("答案过长(>2000字)");
  }

  // 4. 结构完整性
  let structureScore = 0;
  const hasHeadings = /^#{1,4}\s+/m.test(answer);
  const hasBold = /\*\*[^*]+\*\*/.test(answer);
  const hasList = /^[\s]*[-*\d]+[.、)]\s/m.test(answer);
  const hasMultiParagraph = (answer.match(/\n\n/g) || []).length >= 1;

  if (hasHeadings) structureScore += 0.3;
  if (hasBold) structureScore += 0.25;
  if (hasList) structureScore += 0.25;
  if (hasMultiParagraph) structureScore += 0.2;
  if (structureScore < 0.3) issues.push("结构不完整(缺标题/列表/加粗)");

  // 5. 综合分 (加权)
  const overallScore = Math.round(
    (citationCoverage * 25 + groundingScore * 30 + lengthScore * 20 + structureScore * 25)
  );

  return {
    citationCoverage,
    citationCount,
    groundingScore,
    lengthScore,
    structureScore,
    overallScore,
    answerLength,
    issues,
  };
}

function extractChineseKeywords(text: string): Set<string> {
  // 简易中文关键词提取：2-6 字词组
  const words = new Set<string>();
  const cleaned = text.replace(/[^\u4e00-\u9fff]/g, "");
  // bigram & trigram
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i <= cleaned.length - n; i++) {
      words.add(cleaned.substring(i, i + n));
    }
  }
  return words;
}

// ─── 并发控制 ──────────────────────────────────────────────────────────────────
async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────
type EvalResult = {
  question: TestQuestion;
  result: QAResult;
  score: ScoreResult;
};

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("   森林培育学 QA 系统自动评测");
  console.log("═══════════════════════════════════════════════════════\n");

  // 1. 从数据库提取主题
  const topics = await extractTopicsFromDB();

  // 2. 生成题目
  const questions = generateQuestions(topics, MAX_QUESTIONS);
  console.log(`\n📝 生成了 ${questions.length} 道测试题`);

  if (CHAPTER_FILTER) {
    console.log(`   (已过滤章节: "${CHAPTER_FILTER}")`);
  }

  // 按意图统计
  const intentCounts: Record<string, number> = {};
  for (const q of questions) {
    intentCounts[q.intent] = (intentCounts[q.intent] || 0) + 1;
  }
  console.log("   题型分布:", Object.entries(intentCounts).map(([k, v]) => `${k}:${v}`).join(", "));

  if (DRY_RUN) {
    console.log("\n🔍 DRY RUN - 输出前 20 道题:");
    for (const q of questions.slice(0, 20)) {
      console.log(`  [${q.id}] ${q.question}  (${q.intent} | ${q.chapter})`);
    }
    console.log(`\n  ... 共 ${questions.length} 题`);
    return;
  }

  // 3. 检查 API 是否可用
  console.log(`\n🔌 检查 API (${API_BASE})...`);
  try {
    const check = await fetch(`${API_BASE}/api/trpc/qa.ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: { question: "测试连接" } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!check.ok && check.status !== 400) {
      console.error(`❌ API 返回 ${check.status}。请确保系统已启动: npm run dev`);
      process.exit(1);
    }
    console.log("   ✅ API 可用");
  } catch (err: any) {
    console.error(`❌ 无法连接 API: ${err.message}`);
    console.error("   请确保系统已启动: npm run dev");
    process.exit(1);
  }

  // 4. 逐题测试
  console.log(`\n🚀 开始测试 (并发=${CONCURRENCY}, 超时=${TIMEOUT_MS / 1000}s)...\n`);

  const startTime = Date.now();
  let completed = 0;
  let errors = 0;

  const results = await runWithConcurrency(
    questions,
    async (q, idx): Promise<EvalResult> => {
      const result = await askQuestion(q.question);
      const score = result.error
        ? { citationCoverage: 0, citationCount: 0, groundingScore: 0, lengthScore: 0, structureScore: 0, overallScore: 0, answerLength: 0, issues: [result.error] }
        : scoreAnswer(result.answer, result.sources, q.question);

      completed++;
      if (result.error) errors++;

      // 进度输出
      if (completed % 10 === 0 || completed === questions.length) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const pct = ((completed / questions.length) * 100).toFixed(0);
        process.stdout.write(`\r  进度: ${completed}/${questions.length} (${pct}%) | 耗时: ${elapsed}s | 错误: ${errors}`);
      }

      if (VERBOSE && !result.error) {
        console.log(`\n  [${q.id}] ${q.question}`);
        console.log(`    分数=${score.overallScore} 引用=${score.citationCount} 长度=${score.answerLength} 耗时=${result.responseTimeMs}ms`);
        if (score.issues.length) console.log(`    问题: ${score.issues.join(", ")}`);
      }

      return { question: q, result, score };
    },
    CONCURRENCY
  );

  console.log("\n");

  // 5. 生成报告
  generateReport(results, Date.now() - startTime);
}

// ─── 生成报告 ──────────────────────────────────────────────────────────────────
function generateReport(results: EvalResult[], totalTimeMs: number) {
  const valid = results.filter((r) => !r.result.error);
  const errored = results.filter((r) => !!r.result.error);

  console.log("═══════════════════════════════════════════════════════");
  console.log("                    评 测 报 告");
  console.log("═══════════════════════════════════════════════════════\n");

  // 概览
  console.log(`📊 概览`);
  console.log(`  总题数:     ${results.length}`);
  console.log(`  成功:       ${valid.length}`);
  console.log(`  失败/超时:  ${errored.length}`);
  console.log(`  总耗时:     ${(totalTimeMs / 1000).toFixed(1)}s`);
  console.log(`  平均耗时:   ${valid.length > 0 ? (valid.reduce((s, r) => s + r.result.responseTimeMs, 0) / valid.length / 1000).toFixed(2) : "N/A"}s/题`);

  if (valid.length === 0) {
    console.log("\n❌ 没有成功的测试结果，无法生成详细报告。");
    return;
  }

  // 评分统计
  const avgOverall = avg(valid.map((r) => r.score.overallScore));
  const avgCitation = avg(valid.map((r) => r.score.citationCoverage));
  const avgGrounding = avg(valid.map((r) => r.score.groundingScore));
  const avgLength = avg(valid.map((r) => r.score.lengthScore));
  const avgStructure = avg(valid.map((r) => r.score.structureScore));
  const avgAnswerLen = avg(valid.map((r) => r.score.answerLength));

  console.log(`\n📈 评分指标 (0-100)`);
  console.log(`  综合评分:    ${avgOverall.toFixed(1)}`);
  console.log(`  引用覆盖率:  ${(avgCitation * 100).toFixed(1)}%`);
  console.log(`  Grounding:   ${(avgGrounding * 100).toFixed(1)}%`);
  console.log(`  长度适当性:  ${(avgLength * 100).toFixed(1)}%`);
  console.log(`  结构完整性:  ${(avgStructure * 100).toFixed(1)}%`);
  console.log(`  平均答案长度: ${avgAnswerLen.toFixed(0)} 字`);

  // 按题型分析
  console.log(`\n📋 按题型分析`);
  const byIntent: Record<string, EvalResult[]> = {};
  for (const r of valid) {
    (byIntent[r.question.intent] ??= []).push(r);
  }
  console.log("  ┌──────────────┬───────┬────────┬──────────┬──────────┐");
  console.log("  │ 题型         │ 数量  │ 综合分 │ 引用覆盖 │ Grounding│");
  console.log("  ├──────────────┼───────┼────────┼──────────┼──────────┤");
  for (const [intent, items] of Object.entries(byIntent).sort((a, b) => b[1].length - a[1].length)) {
    const o = avg(items.map((r) => r.score.overallScore)).toFixed(1).padStart(5);
    const c = (avg(items.map((r) => r.score.citationCoverage)) * 100).toFixed(0).padStart(5) + "%";
    const g = (avg(items.map((r) => r.score.groundingScore)) * 100).toFixed(0).padStart(5) + "%";
    console.log(`  │ ${intent.padEnd(12)} │ ${String(items.length).padStart(5)} │ ${o}  │ ${c}    │ ${g}    │`);
  }
  console.log("  └──────────────┴───────┴────────┴──────────┴──────────┘");

  // 按章节分析
  console.log(`\n📚 按章节分析 (前 10)`);
  const byChapter: Record<string, EvalResult[]> = {};
  for (const r of valid) {
    (byChapter[r.question.chapter] ??= []).push(r);
  }
  const chapterEntries = Object.entries(byChapter)
    .sort((a, b) => avg(a[1].map((r) => r.score.overallScore)) - avg(b[1].map((r) => r.score.overallScore)));
  for (const [ch, items] of chapterEntries.slice(0, 10)) {
    const score = avg(items.map((r) => r.score.overallScore)).toFixed(1);
    console.log(`  ${score.padStart(5)} 分 │ ${ch} (${items.length}题)`);
  }

  // 最差的 10 题
  console.log(`\n⚠️  最低分 10 题`);
  const worst = [...valid].sort((a, b) => a.score.overallScore - b.score.overallScore).slice(0, 10);
  for (const r of worst) {
    console.log(`  ${String(r.score.overallScore).padStart(3)} 分 │ ${r.question.question}`);
    if (r.score.issues.length) console.log(`         │ 问题: ${r.score.issues.join(", ")}`);
  }

  // 最好的 5 题
  console.log(`\n✅ 最高分 5 题`);
  const best = [...valid].sort((a, b) => b.score.overallScore - a.score.overallScore).slice(0, 5);
  for (const r of best) {
    console.log(`  ${String(r.score.overallScore).padStart(3)} 分 │ ${r.question.question}`);
  }

  // 常见问题统计
  console.log(`\n🔍 常见问题统计`);
  const issueCounts: Record<string, number> = {};
  for (const r of valid) {
    for (const issue of r.score.issues) {
      issueCounts[issue] = (issueCounts[issue] || 0) + 1;
    }
  }
  for (const [issue, count] of Object.entries(issueCounts).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / valid.length) * 100).toFixed(1);
    console.log(`  ${String(count).padStart(5)} 次 (${pct}%) │ ${issue}`);
  }

  // 写出详细 JSON 结果
  const reportPath = `eval-report-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
  const report = {
    summary: {
      total: results.length,
      success: valid.length,
      errors: errored.length,
      totalTimeMs,
      avgOverallScore: avgOverall,
      avgCitationCoverage: avgCitation,
      avgGroundingScore: avgGrounding,
    },
    byIntent: Object.fromEntries(
      Object.entries(byIntent).map(([intent, items]) => [
        intent,
        { count: items.length, avgScore: avg(items.map((r) => r.score.overallScore)) },
      ])
    ),
    details: results.map((r) => ({
      id: r.question.id,
      question: r.question.question,
      chapter: r.question.chapter,
      intent: r.question.intent,
      score: r.score.overallScore,
      citationCount: r.score.citationCount,
      answerLength: r.score.answerLength,
      responseTimeMs: r.result.responseTimeMs,
      issues: r.score.issues,
      error: r.result.error || null,
    })),
  };

  const fs = await import("fs");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 详细报告已保存: ${reportPath}`);

  // 最终评级
  console.log(`\n${"═".repeat(55)}`);
  if (avgOverall >= 80) {
    console.log("  🏆 评级: 优秀 (≥80分) — 系统质量达到部署标准");
  } else if (avgOverall >= 60) {
    console.log("  ✅ 评级: 良好 (60-79分) — 建议优化后部署");
  } else if (avgOverall >= 40) {
    console.log("  ⚠️  评级: 一般 (40-59分) — 需要改进再部署");
  } else {
    console.log("  ❌ 评级: 不及格 (<40分) — 需要重大改进");
  }
  console.log(`${"═".repeat(55)}\n`);
}

function avg(nums: number[]): number {
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

main().catch((err) => {
  console.error("评测脚本出错:", err);
  process.exit(1);
});
