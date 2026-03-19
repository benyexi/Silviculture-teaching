#!/usr/bin/env tsx
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

type QuestionType = "definition" | "classification" | "method" | "comparison" | "entity" | "other";

type BenchmarkQuestion = {
  id: number;
  type: QuestionType;
  question: string;
};

type RawSource = Record<string, unknown> & {
  materialId?: number;
  materialTitle?: string;
  chapter?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
};

type StreamMeta = {
  sources?: RawSource[];
  modelUsed?: string;
  foundInMaterials?: boolean;
  confidence?: number;
  questionLanguage?: string;
  queryId?: number;
  responseTimeMs?: number;
};

type BenchmarkResult = {
  id: number;
  type: QuestionType;
  question: string;
  status: "ok" | "error";
  durationMs: number;
  answer?: string;
  answerLength?: number;
  sourcesCount?: number;
  noiseHit?: boolean;
  noiseSourceHits?: number;
  definitionTooLong?: boolean;
  definitionDrift?: boolean;
  sources?: Array<{
    materialId?: number;
    materialTitle?: string;
    chapter?: string | null;
    pageStart?: number | null;
    pageEnd?: number | null;
  }>;
  error?: string;
};

type ParsedArgs = {
  concurrency: number;
  baseUrl: string;
  questionFile: string;
  outputDir: string;
  timeoutMs: number;
  retries: number;
};

type Summary = {
  totalQuestions: number;
  successCount: number;
  failureCount: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  averageAnswerLength: number;
  p95AnswerLength: number;
  averageSourcesCount: number;
  p95SourcesCount: number;
  noiseHitQuestions: number;
  noiseHitSourceCount: number;
  definitionTooLongCount: number;
  definitionDriftCount: number;
  typeAccuracy: Record<QuestionType, { total: number; heuristicPass: number; heuristicRate: number }>;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_QUESTION_FILE = resolve(SCRIPT_DIR, "questions.zh.json");
const DEFAULT_OUTPUT_DIR = resolve(SCRIPT_DIR, "results");
const DEFAULT_BASE_URL = "http://127.0.0.1:3000/api/stream/ask";
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_RETRIES = 2;

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    concurrency: DEFAULT_CONCURRENCY,
    baseUrl: DEFAULT_BASE_URL,
    questionFile: DEFAULT_QUESTION_FILE,
    outputDir: DEFAULT_OUTPUT_DIR,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
  };

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--concurrency" || value === "-c") {
      args.concurrency = clampInt(Number(argv[++i]), 1, 64, DEFAULT_CONCURRENCY);
      continue;
    }
    if (value.startsWith("--concurrency=")) {
      args.concurrency = clampInt(Number(value.split("=", 2)[1]), 1, 64, DEFAULT_CONCURRENCY);
      continue;
    }
    if (value === "--base-url") {
      args.baseUrl = argv[++i] || DEFAULT_BASE_URL;
      continue;
    }
    if (value.startsWith("--base-url=")) {
      args.baseUrl = value.split("=", 2)[1] || DEFAULT_BASE_URL;
      continue;
    }
    if (value === "--questions") {
      args.questionFile = resolve(argv[++i] || DEFAULT_QUESTION_FILE);
      continue;
    }
    if (value.startsWith("--questions=")) {
      args.questionFile = resolve(value.split("=", 2)[1] || DEFAULT_QUESTION_FILE);
      continue;
    }
    if (value === "--output-dir") {
      args.outputDir = resolve(argv[++i] || DEFAULT_OUTPUT_DIR);
      continue;
    }
    if (value.startsWith("--output-dir=")) {
      args.outputDir = resolve(value.split("=", 2)[1] || DEFAULT_OUTPUT_DIR);
      continue;
    }
    if (value === "--timeout-ms") {
      args.timeoutMs = clampInt(Number(argv[++i]), 5_000, 900_000, DEFAULT_TIMEOUT_MS);
      continue;
    }
    if (value.startsWith("--timeout-ms=")) {
      args.timeoutMs = clampInt(Number(value.split("=", 2)[1]), 5_000, 900_000, DEFAULT_TIMEOUT_MS);
      continue;
    }
    if (value === "--retries") {
      args.retries = clampInt(Number(argv[++i]), 0, 10, DEFAULT_RETRIES);
      continue;
    }
    if (value.startsWith("--retries=")) {
      args.retries = clampInt(Number(value.split("=", 2)[1]), 0, 10, DEFAULT_RETRIES);
    }
  }

  return args;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return Math.min(max, Math.max(min, rounded));
}

function toCodePointLength(text: string): number {
  return Array.from(text).length;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function formatNumber(value: number, digits = 1): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function normalizeQuestion(input: unknown, fallbackId: number): BenchmarkQuestion {
  if (typeof input === "string") {
    return {
      id: fallbackId,
      type: "other",
      question: input,
    };
  }

  if (!input || typeof input !== "object") {
    throw new Error(`Invalid question at index ${fallbackId}`);
  }

  const raw = input as Record<string, unknown>;
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  const type = canonicalizeQuestionType(typeof raw.type === "string" ? raw.type : undefined);
  const id = typeof raw.id === "number" ? raw.id : fallbackId;

  if (!question) {
    throw new Error(`Question ${fallbackId} is missing question text`);
  }
  if (!type) {
    throw new Error(`Question ${id} has invalid type`);
  }

  return { id, type, question };
}

function canonicalizeQuestionType(type: string | undefined): QuestionType | null {
  if (!type) return null;
  const normalized = type.trim().toLowerCase();
  if (normalized === "definition") return "definition";
  if (normalized === "classification" || normalized === "type") return "classification";
  if (normalized === "method") return "method";
  if (normalized === "comparison" || normalized === "compare") return "comparison";
  if (normalized === "entity" || normalized === "person") return "entity";
  if (normalized === "other" || normalized === "chapter" || normalized === "short") return "other";
  return null;
}

function buildTypeAccuracy(results: BenchmarkResult[]): Summary["typeAccuracy"] {
  const empty = (): { total: number; heuristicPass: number; heuristicRate: number } => ({
    total: 0,
    heuristicPass: 0,
    heuristicRate: 0,
  });

  const stats: Summary["typeAccuracy"] = {
    definition: empty(),
    classification: empty(),
    method: empty(),
    comparison: empty(),
    entity: empty(),
    other: empty(),
  };

  for (const result of results) {
    const bucket = stats[result.type];
    bucket.total += 1;
    if (result.status === "ok" && passesHeuristic(result.type, result.answer || "")) {
      bucket.heuristicPass += 1;
    }
  }

  for (const bucket of Object.values(stats)) {
    bucket.heuristicRate = bucket.total > 0 ? bucket.heuristicPass / bucket.total : 0;
  }

  return stats;
}

function passesHeuristic(type: QuestionType, answer: string): boolean {
  const text = answer.trim();
  if (!text) return false;
  switch (type) {
    case "definition":
      return /(定义|概念|是指|指的是)/.test(text);
    case "classification":
      return /(分类|类型|可分为|分为|包括|可归为)/.test(text);
    case "method":
      return /(方法|步骤|流程|程序|措施|要点)/.test(text);
    case "comparison":
      return /(区别|不同|比较|对比|相较|相对于)/.test(text);
    case "entity":
      return /(人物|作者|学者|教授|专家|提出|主编|研究者|先生|女士)/.test(text);
    case "other":
      return /(章|节|要点|内容|概述|简述|教材|范围|部分)/.test(text) || toCodePointLength(text) > 24;
    default:
      return false;
  }
}

function normalizeSources(raw: unknown): Array<{
  materialId?: number;
  materialTitle?: string;
  chapter?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
}> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const source = (item && typeof item === "object" ? item : {}) as RawSource;
    return {
      materialId: typeof source.materialId === "number" ? source.materialId : undefined,
      materialTitle: typeof source.materialTitle === "string" ? source.materialTitle : undefined,
      chapter: typeof source.chapter === "string" || source.chapter === null ? source.chapter : undefined,
      pageStart: typeof source.pageStart === "number" ? source.pageStart : undefined,
      pageEnd: typeof source.pageEnd === "number" ? source.pageEnd : undefined,
    };
  });
}

function isNoiseChapter(chapter: string | null | undefined): boolean {
  if (!chapter) return false;
  return /^\d+(\.\d+)?%?$/.test(chapter) || /复习思考题|思考题|习题/.test(chapter);
}

function computeSummary(results: BenchmarkResult[]): Summary {
  const success = results.filter((item) => item.status === "ok");
  const durations = results.map((item) => item.durationMs);
  const answerLengths = success.map((item) => item.answerLength ?? 0);
  const sourceCounts = success.map((item) => item.sourcesCount ?? 0);

  return {
    totalQuestions: results.length,
    successCount: success.length,
    failureCount: results.length - success.length,
    averageLatencyMs: mean(durations),
    p95LatencyMs: percentile(durations, 95),
    averageAnswerLength: mean(answerLengths),
    p95AnswerLength: percentile(answerLengths, 95),
    averageSourcesCount: mean(sourceCounts),
    p95SourcesCount: percentile(sourceCounts, 95),
    noiseHitQuestions: results.filter((item) => item.noiseHit).length,
    noiseHitSourceCount: results.reduce((sum, item) => sum + (item.noiseSourceHits ?? 0), 0),
    definitionTooLongCount: results.filter((item) => item.definitionTooLong).length,
    definitionDriftCount: results.filter((item) => item.definitionDrift).length,
    typeAccuracy: buildTypeAccuracy(results),
  };
}

function renderMarkdown(summary: Summary, results: BenchmarkResult[], params: ParsedArgs): string {
  const lines: string[] = [];
  lines.push("# 自动回归评测摘要");
  lines.push("");
  lines.push(`- 题库文件: \`${params.questionFile}\``);
  lines.push(`- 服务地址: \`${params.baseUrl}\``);
  lines.push(`- 并发: \`${params.concurrency}\``);
  lines.push(`- 生成时间: \`${new Date().toISOString()}\``);
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("| --- | ---: |");
  lines.push(`| 总题数 | ${summary.totalQuestions} |`);
  lines.push(`| 成功数 | ${summary.successCount} |`);
  lines.push(`| 失败数 | ${summary.failureCount} |`);
  lines.push(`| 平均耗时 | ${formatNumber(summary.averageLatencyMs)} ms |`);
  lines.push(`| P95 耗时 | ${formatNumber(summary.p95LatencyMs)} ms |`);
  lines.push(`| 平均答案长度 | ${formatNumber(summary.averageAnswerLength)} 字符 |`);
  lines.push(`| P95 答案长度 | ${formatNumber(summary.p95AnswerLength)} 字符 |`);
  lines.push(`| 平均 sources 数 | ${formatNumber(summary.averageSourcesCount)} |`);
  lines.push(`| P95 sources 数 | ${formatNumber(summary.p95SourcesCount)} |`);
  lines.push(`| 疑似噪声命中 | ${summary.noiseHitQuestions} 题 / ${summary.noiseHitSourceCount} 条来源 |`);
  lines.push(`| 定义题过长 | ${summary.definitionTooLongCount} |`);
  lines.push(`| 定义题疑似跑偏 | ${summary.definitionDriftCount} |`);
  lines.push("");
  lines.push("## 题型启发式统计");
  lines.push("| 题型 | 样本数 | 启发式命中 | 命中率 |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const type of ["definition", "classification", "method", "comparison", "entity", "other"] as const) {
    const bucket = summary.typeAccuracy[type];
    lines.push(`| ${type} | ${bucket.total} | ${bucket.heuristicPass} | ${Math.round(bucket.heuristicRate * 100)}% |`);
  }

  const failures = results.filter((item) => item.status === "error");
  if (failures.length > 0) {
    lines.push("");
    lines.push("## 失败样本");
    lines.push("| id | type | question | error |");
    lines.push("| --- | --- | --- | --- |");
    for (const item of failures.slice(0, 20)) {
      lines.push(`| ${item.id} | ${item.type} | ${escapeMdCell(item.question)} | ${escapeMdCell(item.error || "unknown error")} |`);
    }
  }

  return lines.join("\n");
}

function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function loadQuestions(questionFile: string): Promise<BenchmarkQuestion[]> {
  const raw = JSON.parse(await readFile(questionFile, "utf8")) as unknown;
  const items = Array.isArray(raw) ? raw : Array.isArray((raw as { questions?: unknown }).questions) ? (raw as { questions: unknown[] }).questions : null;
  if (!items) {
    throw new Error("Question file must be a JSON array or an object with a questions array.");
  }
  return items.map((item, index) => normalizeQuestion(item, index + 1));
}

async function runQuestion(baseUrl: string, timeoutMs: number, retries: number, question: BenchmarkQuestion): Promise<BenchmarkResult> {
  const attempts = Math.max(1, retries + 1);
  let lastResult: BenchmarkResult | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await runQuestionOnce(baseUrl, timeoutMs, question);
    if (result.status === "ok") {
      return result;
    }
    lastResult = result;
    if (attempt < attempts) {
      await sleep(500 * attempt);
    }
  }

  return lastResult || {
    id: question.id,
    type: question.type,
    question: question.question,
    status: "error",
    durationMs: 0,
    error: "unknown error",
  };
}

async function runQuestionOnce(baseUrl: string, timeoutMs: number, question: BenchmarkQuestion): Promise<BenchmarkResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs} ms`)), timeoutMs);

  try {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ question: question.question }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    if (!response.body) {
      throw new Error("Empty response body");
    }

    const { answer, sources } = await parseStream(response.body);
    const durationMs = Date.now() - startedAt;
    const answerLength = toCodePointLength(answer.trim());
    const sourcesCount = sources.length;
    const noiseSourceHits = sources.filter((source) => isNoiseChapter(source.chapter)).length;
    const noiseHit = noiseSourceHits > 0;
    const definitionTooLong = question.type === "definition" && answerLength > 220;
    const definitionDrift = question.type === "definition" && !/(定义|概念|是指|指的是)/.test(answer);

    return {
      id: question.id,
      type: question.type,
      question: question.question,
      status: "ok",
      durationMs,
      answer,
      answerLength,
      sourcesCount,
      noiseHit,
      noiseSourceHits,
      definitionTooLong,
      definitionDrift,
      sources,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    return {
      id: question.id,
      type: question.type,
      question: question.question,
      status: "error",
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseStream(body: ReadableStream<Uint8Array>): Promise<{ answer: string; sources: BenchmarkResult["sources"] }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let answer = "";
  let sources: BenchmarkResult["sources"] = [];

  const flushEvent = () => {
    if (!eventName && dataLines.length === 0) return;
    const payloadText = dataLines.join("\n");
    let payload: unknown = null;
    if (payloadText) {
      try {
        payload = JSON.parse(payloadText);
      } catch (error) {
        throw new Error(`Invalid SSE payload for event "${eventName || "message"}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (eventName === "meta") {
      const meta = (payload && typeof payload === "object" ? payload : {}) as StreamMeta;
      sources = normalizeSources(meta.sources);
    } else if (eventName === "token") {
      const token = payload && typeof payload === "object" ? (payload as { t?: unknown }).t : undefined;
      if (typeof token === "string") answer += token;
    } else if (eventName === "done") {
      const done = (payload && typeof payload === "object" ? payload : {}) as { answer?: unknown };
      if (typeof done.answer === "string") answer = done.answer;
    } else if (eventName === "error") {
      const err = (payload && typeof payload === "object" ? payload : {}) as { message?: unknown };
      throw new Error(typeof err.message === "string" ? err.message : "stream error");
    }

    eventName = "";
    dataLines = [];
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r/g, "");

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line === "") {
          flushEvent();
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    if (buffer.trim()) {
      const line = buffer.trimEnd();
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }

    flushEvent();
  } finally {
    reader.releaseLock();
  }

  return { answer, sources };
}

async function main() {
  const params = parseArgs(process.argv.slice(2));
  const questions = await loadQuestions(params.questionFile);
  await mkdir(params.outputDir, { recursive: true });

  const results: BenchmarkResult[] = new Array(questions.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= questions.length) return;
      results[currentIndex] = await runQuestion(params.baseUrl, params.timeoutMs, params.retries, questions[currentIndex]);
      process.stdout.write(
        `[${currentIndex + 1}/${questions.length}] ${results[currentIndex].status.toUpperCase()} ${questions[currentIndex].question}\n`
      );
    }
  };

  const workers = Array.from({ length: Math.min(params.concurrency, questions.length) }, () => worker());
  await Promise.all(workers);

  const summary = computeSummary(results);
  const output = {
    generatedAt: new Date().toISOString(),
    baseUrl: params.baseUrl,
    concurrency: params.concurrency,
    questionFile: params.questionFile,
    summary,
    results,
  };

  const jsonPath = resolve(params.outputDir, "latest.json");
  const mdPath = resolve(params.outputDir, "latest.md");

  await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await writeFile(mdPath, `${renderMarkdown(summary, results, params)}\n`, "utf8");

  process.stdout.write(`\nWrote ${jsonPath}\nWrote ${mdPath}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
