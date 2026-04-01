/**
 * 文档处理管道
 * 上传 PDF/Word → 提取文本 → 智能分块（按章节/段落）→ 向量化 → 存储
 */
import { getDb, getActiveLlmConfig } from "./db";
import { materials, materialChunks } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { detectDocumentLanguage } from "./languageDetect";
import { getEmbedding, getEmbeddings } from "./llmDriver";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";

// ─── 文本块类型 ───────────────────────────────────────────────────────────────
type TextChunk = {
  content: string;
  chapter: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  tokenCount: number;
  startOffset?: number | null;
  endOffset?: number | null;
};

type SectionSourceSpan = {
  sectionStart: number;
  sectionEnd: number;
  pageNumber: number;
  pageStartOffset: number;
  pageEndOffset: number;
};
type SemanticBlock = { text: string; startOffset: number; endOffset: number };
type ChunkSlice = { content: string; overlapContent: string; sourceStart: number; sourceEnd: number };

const HEADING_PATTERN =
  /^(第[一二三四五六七八九十百零\d]+[章节篇部编]|[\d]+\.[\d]+[\s\S]{0,30}|[一二三四五六七八九十]+[、．.]\s*\S|Chapter\s+\d+(?:\.\d+)*|CHAPTER\s+\d+(?:\.\d+)*|Part\s+[IVX\d]+|Section\s+\d+(?:\.\d+)*|SECTION\s+\d+(?:\.\d+)*|\d+(?:\.\d+){0,3}\s+[A-Z][A-Za-z0-9 ,:;()\-]{2,90})$/i;

const LIST_ITEM_PATTERN =
  /^(?:[（(]?(?:[一二三四五六七八九十百千零\d]+|[a-zA-Z]+)[)）.、．]|(?:\d+|[ivxlcdmIVXLCDM]+)[)）.、．]|[-*•·●○])\s*\S/;

type ChunkingProfile = {
  targetSize: number;
  minSize: number;
  maxSize: number;
  overlapSize: number;
  sectionMergeSize: number;
};

function getChunkingProfile(language: "zh" | "en" | string | null | undefined): ChunkingProfile {
  if (language === "en") {
    return {
      targetSize: 1500,
      minSize: 800,
      maxSize: 1850,
      overlapSize: 220,
      sectionMergeSize: 900,
    };
  }

  return {
    targetSize: 860,
    minSize: 420,
    maxSize: 1080,
    overlapSize: 150,
    sectionMergeSize: 500,
  };
}

function isListItemLine(line: string): boolean {
  return LIST_ITEM_PATTERN.test(line.trim());
}

function isStructuralBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  return HEADING_PATTERN.test(trimmed) || isListItemLine(trimmed);
}

function mergeSectionText(a: string, b: string): string {
  return `${a.trim()}\n${b.trim()}`.trim();
}

function mergeShortSections(
  sections: { chapter: string | null; text: string; pageStart: number | null; pageEnd: number | null; spans?: SectionSourceSpan[] }[],
  minSize: number
) {
  const merged: typeof sections = [];

  for (const section of sections) {
    const current = { ...section, text: section.text.trim() };
    if (current.text.length === 0) continue;

    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(current);
      continue;
    }

    const shouldMerge =
      last.text.length < minSize ||
      current.text.length < minSize ||
      last.text.length + current.text.length <= minSize * 1.8;

    if (shouldMerge) {
      const offset = last.text.trim().length + 1; // +1 for the '\n' separator
      last.text = mergeSectionText(last.text, current.text);
      last.pageEnd = current.pageEnd ?? last.pageEnd;
      if (!last.chapter && current.chapter) last.chapter = current.chapter;
      // Merge spans: offset the incoming section's spans by where it starts in the merged text
      if (current.spans && current.spans.length > 0) {
        const shiftedSpans = current.spans.map(s => ({
          ...s,
          sectionStart: s.sectionStart + offset,
          sectionEnd: s.sectionEnd + offset,
        }));
        last.spans = [...(last.spans ?? []), ...shiftedSpans];
      }
      continue;
    }

    merged.push(current);
  }

  if (merged.length > 1 && merged[merged.length - 1].text.length < minSize) {
    const tail = merged.pop();
    if (tail) {
      const prev = merged[merged.length - 1];
      if (prev) {
        const offset = prev.text.trim().length + 1;
        prev.text = mergeSectionText(prev.text, tail.text);
        prev.pageEnd = tail.pageEnd ?? prev.pageEnd;
        if (tail.spans && tail.spans.length > 0) {
          const shiftedSpans = tail.spans.map(s => ({
            ...s,
            sectionStart: s.sectionStart + offset,
            sectionEnd: s.sectionEnd + offset,
          }));
          prev.spans = [...(prev.spans ?? []), ...shiftedSpans];
        }
      } else {
        merged.push(tail);
      }
    }
  }

  return merged;
}

function splitIntoSemanticBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const blocks: string[] = [];
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  let buffer: string[] = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const joined = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (joined) blocks.push(joined);
    buffer = [];
  };

  for (const line of lines) {
    if (isStructuralBoundaryLine(line)) {
      flushBuffer();
      blocks.push(line);
      continue;
    }

    if (line.length <= 36 && (HEADING_PATTERN.test(line) || /[:：]$/.test(line))) {
      flushBuffer();
      blocks.push(line);
      continue;
    }

    buffer.push(line);
  }

  flushBuffer();
  return blocks;
}

function takeOverlapTail(text: string, overlapSize: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= overlapSize) return trimmed;

  const searchStart = Math.max(0, trimmed.length - overlapSize * 2);
  const windowText = trimmed.slice(searchStart);

  for (let i = 0; i < windowText.length; i++) {
    const ch = windowText[i];
    if (ch === "\n" || ch === "。" || ch === "！" || ch === "？" || ch === "." || ch === "!" || ch === "?") {
      const candidate = windowText.slice(i + 1).trim();
      if (candidate.length >= Math.floor(overlapSize * 0.5)) {
        return candidate;
      }
    }
  }

  return trimmed.slice(Math.max(0, trimmed.length - overlapSize)).trim();
}

function splitLongTextByBoundary(text: string, profile: ChunkingProfile): string[] {
  const pieces: string[] = [];
  let remaining = text.trim();

  while (remaining.length > profile.maxSize) {
    const cutPos = splitAtNaturalBoundary(remaining, profile.targetSize);
    let piece = remaining.slice(0, cutPos).trim();

    if (piece.length < profile.minSize) {
      const fallbackCut = Math.min(remaining.length, profile.maxSize);
      piece = remaining.slice(0, fallbackCut).trim();
    }

    if (!piece) break;
    pieces.push(piece);

    const overlapTail = takeOverlapTail(piece, profile.overlapSize);
    const nextStart = Math.max(0, piece.length - overlapTail.length);
    remaining = remaining.slice(nextStart).trimStart();

    if (remaining.length === 0) break;
  }

  if (remaining.trim()) pieces.push(remaining.trim());

  return pieces.filter((piece) => piece.length > 0);
}

// ─── 支持的文件类型 ──────────────────────────────────────────────────────────
function getFileType(filename: string): "pdf" | "docx" | "doc" {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "doc") return "doc";
  if (ext === "docx") return "docx";
  return "pdf";
}

type MaterialProcessJob = {
  materialId: number;
  filename: string;
  loadBuffer: () => Promise<Buffer>;
  onDone?: () => void;
  onError?: (error: unknown) => void;
};

const MATERIAL_PROCESS_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.MATERIAL_PROCESS_CONCURRENCY || "1", 10)
);
const materialProcessQueue: MaterialProcessJob[] = [];
let activeMaterialProcessJobs = 0;

function pumpMaterialProcessQueue(): void {
  while (activeMaterialProcessJobs < MATERIAL_PROCESS_CONCURRENCY && materialProcessQueue.length > 0) {
    const job = materialProcessQueue.shift();
    if (!job) break;
    activeMaterialProcessJobs++;
    void runMaterialProcessJob(job);
  }
}

async function runMaterialProcessJob(job: MaterialProcessJob): Promise<void> {
  try {
    const buffer = await job.loadBuffer();
    await processMaterial(job.materialId, buffer, job.filename);
    job.onDone?.();
  } catch (error) {
    if (job.onError) {
      job.onError(error);
    } else {
      console.error(`[DocQueue] 教材 ${job.materialId} 处理失败:`, error);
    }
  } finally {
    activeMaterialProcessJobs = Math.max(0, activeMaterialProcessJobs - 1);
    pumpMaterialProcessQueue();
  }
}

export function enqueueMaterialProcessing(job: MaterialProcessJob): void {
  materialProcessQueue.push(job);
  pumpMaterialProcessQueue();
}

export function getMaterialProcessingQueueStats() {
  return {
    active: activeMaterialProcessJobs,
    queued: materialProcessQueue.length,
    concurrency: MATERIAL_PROCESS_CONCURRENCY,
  };
}

async function getEmbeddingWithRetry(text: string, maxAttempts = 3): Promise<number[] | undefined> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await getEmbedding(text);
    } catch (error) {
      attempt++;
      if (attempt >= maxAttempts) break;
      const backoffMs = Math.min(1200, 250 * Math.pow(2, attempt - 1));
      await sleep(backoffMs);
    }
  }
  return undefined;
}

async function getEmbeddingsWithRetry(texts: string[], maxAttempts = 2): Promise<(number[] | undefined)[]> {
  if (texts.length === 0) return [];
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      const vectors = await getEmbeddings(texts);
      return vectors.map((vec) => vec || undefined);
    } catch (error) {
      attempt++;
      if (attempt >= maxAttempts) break;
      const backoffMs = Math.min(1500, 300 * Math.pow(2, attempt - 1));
      await sleep(backoffMs);
    }
  }
  return new Array(texts.length).fill(undefined);
}

// ─── 主处理函数 ───────────────────────────────────────────────────────────────
export async function processMaterial(
  materialId: number,
  fileBuffer: Buffer,
  filename: string = "document.pdf"
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");
  const fileType = getFileType(filename);

  try {
    // 更新状态为处理中
    await db
      .update(materials)
      .set({ status: "processing" })
      .where(eq(materials.id, materialId));

    // 1. 提取文档文本
    console.log(`[Doc] 开始提取教材 ${materialId} 的文本 (${fileType})...`);
    const { text, pageTexts } =
      fileType === "doc"
        ? await extractDocText(fileBuffer)
        : fileType === "docx"
          ? await extractDocxText(fileBuffer)
          : await extractPdfText(fileBuffer);
    const detectedLanguage = detectDocumentLanguage(text);
    console.log(`[Doc] 检测到教材语言: ${detectedLanguage}`);

    // 2. 智能分块
    console.log(`[Doc] 开始分块，总文本长度: ${text.length} 字符`);
    const chunks = splitIntoChunks(text, pageTexts, detectedLanguage);
    console.log(`[Doc] 分块完成，共 ${chunks.length} 个块`);

    // 3. 存储文本块到数据库（不依赖 useRAG，先全部入库为 fulltext）
    const activeConfig = await getActiveLlmConfig();
    const BATCH_SIZE = Math.max(4, parseInt(process.env.DOC_EMBED_BATCH_SIZE || "16", 10));

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (chunk, batchIdx) => {
          const idx = i + batchIdx;

          await db.insert(materialChunks).values({
            materialId,
            chunkIndex: idx,
            content: chunk.content,
            chapter: chunk.chapter,
            pageStart: chunk.pageStart,
            pageEnd: chunk.pageEnd,
            tokenCount: chunk.tokenCount,
            startOffset: chunk.startOffset ?? null,
            endOffset: chunk.endOffset ?? null,
            vectorId: "fulltext",
          });
        })
      );
      console.log(`[Doc] 已写入 ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length} 个块`);
    }

    // 4. 更新教材状态为已发布
    await db
      .update(materials)
      .set({ status: "published", totalChunks: chunks.length, language: detectedLanguage })
      .where(eq(materials.id, materialId));

    // 5. 如果配置了 embeddingModel 和 embeddingApiKey，异步回填 embedding
    if (activeConfig?.embeddingModel && activeConfig?.embeddingApiKey) {
      void backfillMaterialEmbeddings(materialId);
    } else {
      console.log(`[Doc] 未配置 embeddingModel/embeddingApiKey，跳过 Embedding 生成`);
    }

    console.log(`[Doc] 教材 ${materialId} 处理完成！`);
  } catch (error) {
    console.error(`[Doc] 教材 ${materialId} 处理失败:`, error);
    await db
      .update(materials)
      .set({
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      .where(eq(materials.id, materialId));
    throw error;
  }
}

// ─── PDF 结构化文本重建 ──────────────────────────────────────────────────────
function buildStructuredPdfPageText(items: any[]): string {
  const glyphs = (items || [])
    .map((item: any) => ({
      str: item.str || "",
      x: item.transform?.[4] ?? 0,
      y: item.transform?.[5] ?? 0,
      width: item.width ?? 0,
      height: Math.abs(item.height ?? item.transform?.[0] ?? 0) || 12,
    }))
    .filter(g => g.str.trim().length > 0);
  if (!glyphs.length) return "";

  glyphs.sort((a, b) => Math.abs(b.y - a.y) > 0.01 ? b.y - a.y : a.x - b.x);
  const buckets: Array<{y:number; height:number; items:typeof glyphs}> = [];
  for (const g of glyphs) {
    const bucket = buckets.find(b => Math.abs(b.y - g.y) <= Math.max(2.5, Math.min(b.height, g.height) * 0.45));
    if (bucket) { bucket.items.push(g); bucket.y = (bucket.y*(bucket.items.length-1)+g.y)/bucket.items.length; bucket.height = Math.max(bucket.height, g.height); }
    else buckets.push({ y: g.y, height: g.height, items: [g] });
  }

  const lines = buckets
    .sort((a,b) => Math.abs(b.y-a.y) > 0.01 ? b.y-a.y : 0)
    .map(bucket => {
      const sorted = [...bucket.items].sort((a,b) => a.x - b.x);
      let line = ""; let prev: typeof glyphs[0] | null = null;
      for (const item of sorted) {
        const part = item.str.trim();
        if (!part) continue;
        if (prev) {
          const gap = item.x - (prev.x + Math.max(prev.width, 0));
          const cw = Math.max(1, Math.min(12, prev.width / Math.max(prev.str.length, 1)));
          const isCjk = /[\u4e00-\u9fff]$/.test(line) || /^[\u4e00-\u9fff]/.test(part);
          if (gap > Math.max(1.5, cw * 0.18) && !isCjk) line += " ";
        }
        line += part; prev = item;
      }
      return line.trim();
    })
    .filter(l => l.length > 0);

  const paragraphs: string[] = [];
  let cur: string[] = [];
  let prevLine: {text:string; y:number; height:number} | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bucket = buckets[i];
    const gap = prevLine ? prevLine.y - bucket.y : 0;
    const isHeading = line.length <= 36 && (HEADING_PATTERN.test(line) || /[:：]$/.test(line));
    const breakPara = prevLine && (isHeading || gap > Math.max(prevLine.height, bucket.height) * 1.45);
    if (breakPara && cur.length) { paragraphs.push(cur.join("\n")); cur = []; }
    cur.push(line);
    prevLine = { text: line, y: bucket.y, height: bucket.height };
  }
  if (cur.length) paragraphs.push(cur.join("\n"));
  return paragraphs.filter(Boolean).join("\n\n");
}

// ─── PDF 文本提取（pdf-parse v1.1.1，支持 Buffer 输入）──────────────────────────
async function extractPdfText(
  pdfBuffer: Buffer
): Promise<{ text: string; pageTexts: string[] }> {
  // 使用 createRequire 在 ESM 环境中加载 CJS 模块
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  // 直接加载 lib/pdf-parse.js 避免 index.js 的测试代码问题
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (buf: Buffer, opts?: any) => Promise<{ text: string; numpages: number }>;

  const pageTexts: string[] = [];

  const data = await pdfParse(pdfBuffer, {
    // 逐页回调，收集每页文本（基于 y 坐标聚类的结构化提取）
    pagerender: (pageData: any) => {
      return pageData.getTextContent().then((textContent: any) => {
        const items: any[] = textContent.items || [];
        const pageText = buildStructuredPdfPageText(items);
        pageTexts.push(pageText);
        return pageText;
      });
    },
  });

  // 如果 pagerender 没有触发（某些 PDF 格式），使用 data.text 按换页符分割
  if (pageTexts.length === 0 && data.text) {
    const pages = data.text.split(/\f/);
    pageTexts.push(...pages.filter((p: string) => p.trim().length > 0));
  }

  return { text: data.text || pageTexts.join("\n"), pageTexts };
}

// ─── Word (.docx) 文本提取 ──────────────────────────────────────────────────
async function extractDocxText(
  docxBuffer: Buffer
): Promise<{ text: string; pageTexts: string[] }> {
  const result = await mammoth.extractRawText({ buffer: docxBuffer });
  const text = result.value;

  // Word 文件没有物理页面概念，按章节标题或段落分组模拟 "页面"
  // 这样 splitIntoChunks 仍能正常工作
  const lines = text.split("\n");
  const sections: string[] = [];
  let currentSection = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 遇到章节标题时，开始新的 section
    if (HEADING_PATTERN.test(trimmed) && currentSection.trim().length > 100) {
      sections.push(currentSection.trim());
      currentSection = trimmed + "\n";
    } else {
      currentSection += trimmed + "\n";
    }
  }
  if (currentSection.trim()) {
    sections.push(currentSection.trim());
  }

  // 如果没有检测到章节划分，将整个文本作为一个 section
  if (sections.length === 0 && text.trim()) {
    sections.push(text.trim());
  }

  return { text, pageTexts: sections };
}

// ─── Word (.doc) 文本提取（旧版二进制格式）─────────────────────────────────
async function extractDocText(
  docBuffer: Buffer
): Promise<{ text: string; pageTexts: string[] }> {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(docBuffer);
  const text = doc.getBody();

  // 与 docx 一样，按章节标题分组模拟 "页面"
  const lines = text.split("\n");
  const sections: string[] = [];
  let currentSection = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (HEADING_PATTERN.test(trimmed) && currentSection.trim().length > 100) {
      sections.push(currentSection.trim());
      currentSection = trimmed + "\n";
    } else {
      currentSection += trimmed + "\n";
    }
  }
  if (currentSection.trim()) {
    sections.push(currentSection.trim());
  }

  if (sections.length === 0 && text.trim()) {
    sections.push(text.trim());
  }

  return { text, pageTexts: sections };
}

// ─── 智能文本分块 ─────────────────────────────────────────────────────────────
// 改进策略：
//   1. 按段落/句子自然边界切割，不在句子中间断开
//   2. 加 overlap（前后重叠），保证上下文连贯
//   3. 每个 chunk 前缀加上所属章节标题，提升检索命中率
/** 在自然断句处切割文本，返回不超过 maxLen 的文本 */
function splitAtNaturalBoundary(text: string, maxLen: number): number {
  if (text.length <= maxLen) return text.length;

  // 优先在段落换行处切割
  const paragraphBreak = text.lastIndexOf("\n", maxLen);
  if (paragraphBreak > maxLen * 0.4) return paragraphBreak + 1;

  // 再优先在列表或小节边界切割
  let lastStructuralBoundary = -1;
  const searchRange = text.substring(0, maxLen);
  for (let i = searchRange.length - 1; i > maxLen * 0.3; i--) {
    if (searchRange[i] !== "\n") continue;
    const nextLine = searchRange.slice(i + 1).trimStart();
    if (!nextLine) continue;
    if (isStructuralBoundaryLine(nextLine)) {
      lastStructuralBoundary = i + 1;
      break;
    }
  }
  if (lastStructuralBoundary > maxLen * 0.35) return lastStructuralBoundary;

  // 其次在句号/问号/感叹号处切割（中文+英文标点）
  // 从后往前找最后一个句子结束符
  let lastSentenceEnd = -1;
  for (let i = searchRange.length - 1; i > maxLen * 0.3; i--) {
    const ch = searchRange[i];
    if (ch === '。' || ch === '！' || ch === '？' || ch === '.' || ch === '!' || ch === '?') {
      lastSentenceEnd = i + 1;
      break;
    }
  }
  if (lastSentenceEnd > maxLen * 0.4) return lastSentenceEnd;

  // 最后在分号/逗号处切割
  for (let i = searchRange.length - 1; i > maxLen * 0.5; i--) {
    const ch = searchRange[i];
    if (ch === '；' || ch === '，' || ch === ';' || ch === ',') {
      return i + 1;
    }
  }

  // 实在找不到就硬切
  return maxLen;
}

/** 将连续文本按段落/句子边界分块，带 overlap */
function splitTextWithOverlap(
  text: string,
  chapter: string | null,
  profile: ChunkingProfile
): ChunkSlice[] {
  const results: ChunkSlice[] = [];
  const chapterPrefix = chapter ? `【${chapter}】\n` : "";
  const adjustedProfile = {
    ...profile,
    targetSize: Math.max(profile.targetSize - chapterPrefix.length, profile.minSize),
    maxSize: Math.max(profile.maxSize - chapterPrefix.length, profile.targetSize),
  };

  const blocks = splitIntoSemanticBlocks(text);
  if (blocks.length === 0) return [];

  let current = "";

  const findSourceOffsets = (raw: string): { sourceStart: number; sourceEnd: number } => {
    const idx = text.indexOf(raw);
    if (idx >= 0) return { sourceStart: idx, sourceEnd: idx + raw.length };
    return { sourceStart: 0, sourceEnd: text.length };
  };

  const emitCurrent = () => {
    const trimmed = current.trim();
    if (!trimmed) {
      current = "";
      return;
    }

    if (trimmed.length < adjustedProfile.minSize && results.length > 0) {
      const merged = mergeSectionText(results[results.length - 1].overlapContent, trimmed);
      const offsets = findSourceOffsets(merged);
      results[results.length - 1] = {
        content: chapterPrefix + merged,
        overlapContent: merged,
        sourceStart: results[results.length - 1].sourceStart,
        sourceEnd: offsets.sourceEnd,
      };
    } else {
      const offsets = findSourceOffsets(trimmed);
      results.push({
        content: chapterPrefix + trimmed,
        overlapContent: trimmed,
        sourceStart: offsets.sourceStart,
        sourceEnd: offsets.sourceEnd,
      });
    }

    current = "";
  };

  for (const block of blocks) {
    if (!block) continue;

    if (block.length > adjustedProfile.maxSize) {
      emitCurrent();
      const pieces = splitLongTextByBoundary(block, adjustedProfile);
      for (const piece of pieces) {
        const trimmedPiece = piece.trim();
        if (!trimmedPiece) continue;
        if (results.length > 0 && trimmedPiece.length < adjustedProfile.minSize) {
          const merged = mergeSectionText(results[results.length - 1].overlapContent, trimmedPiece);
          const mergedOffsets = findSourceOffsets(merged);
          results[results.length - 1] = {
            content: chapterPrefix + merged,
            overlapContent: merged,
            sourceStart: results[results.length - 1].sourceStart,
            sourceEnd: mergedOffsets.sourceEnd,
          };
        } else {
          const pieceOffsets = findSourceOffsets(trimmedPiece);
          results.push({
            content: chapterPrefix + trimmedPiece,
            overlapContent: trimmedPiece,
            sourceStart: pieceOffsets.sourceStart,
            sourceEnd: pieceOffsets.sourceEnd,
          });
        }
      }
      continue;
    }

    if (!current) {
      current = block;
      continue;
    }

    const projectedLength = current.length + 1 + block.length;
    const shouldBreakBeforeBlock =
      current.length >= adjustedProfile.minSize &&
      (isStructuralBoundaryLine(block) || projectedLength > adjustedProfile.targetSize);

    if (shouldBreakBeforeBlock) {
      emitCurrent();
      const overlap = results.length > 0 ? takeOverlapTail(results[results.length - 1].overlapContent, adjustedProfile.overlapSize) : "";
      current = overlap ? `${overlap}\n${block}` : block;
      continue;
    }

    current = `${current}\n${block}`;
  }

  emitCurrent();
  return results;
}

function splitIntoChunks(text: string, pageTexts: string[], language: "zh" | "en" | string = "zh"): TextChunk[] {
  const chunks: TextChunk[] = [];
  const profile = getChunkingProfile(language);
  const sectionThreshold = Math.max(80, Math.floor(profile.minSize * 0.35));

  // 第一步：按章节/小节标题把全文分成 sections
  type Section = { chapter: string | null; text: string; pageStart: number | null; pageEnd: number | null; spans?: SectionSourceSpan[] };
  const sections: Section[] = [];

  if (pageTexts.length > 0) {
    let currentChapter: string | null = null;
    let currentText = "";
    let sectionPageStart: number | null = 1;
    let sectionPageEnd: number | null = 1;
    let currentSpans: SectionSourceSpan[] = [];
    let curPageContribStart = 0; // offset in currentText where current page started contributing

    for (let pageIdx = 0; pageIdx < pageTexts.length; pageIdx++) {
      const pageText = pageTexts[pageIdx].trim();
      if (!pageText) continue;
      const pageNum = pageIdx + 1;

      // This page starts contributing at the current end of currentText
      curPageContribStart = currentText.length;

      const lines = pageText.split("\n");
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (HEADING_PATTERN.test(line)) {
          // Close this page's span contribution to the old section
          if (currentText.length > curPageContribStart) {
            currentSpans.push({
              sectionStart: curPageContribStart,
              sectionEnd: currentText.length,
              pageNumber: pageNum,
              pageStartOffset: 0,
              pageEndOffset: currentText.length - curPageContribStart,
            });
          }
          // 遇到新标题，保存当前 section
          if (currentText.trim().length >= sectionThreshold) {
            sections.push({
              chapter: currentChapter,
              text: currentText.trim(),
              pageStart: sectionPageStart,
              pageEnd: sectionPageEnd,
              spans: currentSpans,
            });
          }
          currentSpans = [];
          currentChapter = line.substring(0, 100);
          currentText = line + "\n";
          sectionPageStart = pageNum;
          sectionPageEnd = pageNum;
          // Reset: this page now contributes to the new section from offset 0
          curPageContribStart = 0;
        } else {
          currentText += line + "\n";
          sectionPageEnd = pageNum;
        }
      }

      // End of page: close the span for this page's contribution to the current section
      if (currentText.length > curPageContribStart) {
        currentSpans.push({
          sectionStart: curPageContribStart,
          sectionEnd: currentText.length,
          pageNumber: pageNum,
          pageStartOffset: 0,
          pageEndOffset: currentText.length - curPageContribStart,
        });
      }
    }
    // 最后一个 section
    if (currentText.trim().length >= sectionThreshold) {
      sections.push({
        chapter: currentChapter,
        text: currentText.trim(),
        pageStart: sectionPageStart,
        pageEnd: sectionPageEnd,
        spans: currentSpans,
      });
    }
  } else {
    // 没有页面信息的情况（Word 等）
    let currentChapter: string | null = null;
    let currentText = "";

    const lines = text.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (HEADING_PATTERN.test(line)) {
        if (currentText.trim().length >= sectionThreshold) {
          sections.push({ chapter: currentChapter, text: currentText.trim(), pageStart: null, pageEnd: null });
        }
        currentChapter = line.substring(0, 100);
        currentText = line + "\n";
      } else {
        currentText += line + "\n";
      }
    }
    if (currentText.trim().length >= sectionThreshold) {
      sections.push({ chapter: currentChapter, text: currentText.trim(), pageStart: null, pageEnd: null });
    }
  }

  // 如果没有检测到任何 section（比如教材格式特殊），整体作为一个 section
  if (sections.length === 0 && text.trim().length >= sectionThreshold) {
    sections.push({ chapter: null, text: text.trim(), pageStart: 1, pageEnd: pageTexts.length || null });
  }

  const normalizedSections = mergeShortSections(sections, profile.sectionMergeSize);

  // 第二步：对每个 section 做带 overlap 的自然边界分块
  for (const section of normalizedSections) {
    const pieces = splitTextWithOverlap(section.text, section.chapter, profile);
    for (const piece of pieces) {
      const pageRange = resolveChunkOffsetsFromSection(
        section.spans ?? [],
        piece.sourceStart,
        piece.sourceEnd,
        section.pageStart,
        section.pageEnd,
      );
      chunks.push({
        content: piece.content,
        chapter: section.chapter,
        pageStart: pageRange.pageStart,
        pageEnd: pageRange.pageEnd,
        tokenCount: estimateTokens(piece.content),
        startOffset: pageRange.startOffset,
        endOffset: pageRange.endOffset,
      });
    }
  }

  return chunks.filter((c) => c.content.trim().length >= sectionThreshold);
}

// ─── Token 估算（中文约 1.5 字符/token，英文约 4 字符/token）────────────────
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Offset 辅助函数 ─────────────────────────────────────────────────────────
function getTrimmedSpan(text: string, start: number, end: number) {
  let s = start, e = end;
  while (s < e && /\s/.test(text[s] || "")) s++;
  while (e > s && /\s/.test(text[e-1] || "")) e--;
  if (s >= e) return null;
  return { text: text.slice(s, e), startOffset: s, endOffset: e };
}

function splitLinesWithOffsets(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines: Array<{text:string; startOffset:number; endOffset:number; isBlank:boolean}> = [];
  let lineStart = 0;
  for (let i = 0; i <= normalized.length; i++) {
    if (i !== normalized.length && normalized[i] !== "\n") continue;
    const span = getTrimmedSpan(normalized, lineStart, i);
    lines.push(span
      ? { text: span.text, startOffset: span.startOffset, endOffset: span.endOffset, isBlank: false }
      : { text: "", startOffset: i, endOffset: i, isBlank: true });
    lineStart = i + 1;
  }
  return lines;
}

function resolveChunkOffsetsFromSection(
  spans: SectionSourceSpan[], sourceStart: number, sourceEnd: number,
  fallbackPageStart: number | null, fallbackPageEnd: number | null
) {
  if (spans.length === 0) return { pageStart: fallbackPageStart, pageEnd: fallbackPageEnd, startOffset: null, endOffset: null };
  const startSpan = spans.find(s => s.sectionEnd > sourceStart) ?? spans[0];
  const endSpan = [...spans].reverse().find(s => s.sectionStart < sourceEnd) ?? spans[spans.length-1];
  const startDelta = Math.max(0, Math.min(sourceStart - startSpan.sectionStart, startSpan.pageEndOffset - startSpan.pageStartOffset));
  const endDelta = Math.max(0, Math.min(sourceEnd - endSpan.sectionStart, endSpan.pageEndOffset - endSpan.pageStartOffset));
  return {
    pageStart: startSpan.pageNumber ?? fallbackPageStart,
    pageEnd: endSpan.pageNumber ?? fallbackPageEnd,
    startOffset: startSpan.pageStartOffset + startDelta,
    endOffset: endSpan.pageStartOffset + endDelta,
  };
}

// ─── Embedding 回填（异步，不阻塞入库流程）────────────────────────────────────
export async function backfillMaterialEmbeddings(materialId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const BATCH_SIZE = Math.max(4, parseInt(process.env.DOC_EMBED_BATCH_SIZE || "16", 10));

  console.log(`[Embed] 开始为教材 ${materialId} 回填 Embedding...`);

  // 先测试 Embedding 是否可用
  try {
    await getEmbeddings(["test"]);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes("401") || msg.includes("Authentication") || msg.includes("invalid")) {
      console.warn(`[Embed] ⚠️ Embedding API Key 无效，跳过回填。错误: ${msg}`);
    } else if (msg.includes("未配置")) {
      console.log(`[Embed] Embedding 未配置，跳过回填`);
    } else {
      console.warn(`[Embed] Embedding 不可用（${msg}），跳过回填`);
    }
    return;
  }

  // 查询所有 vectorId = "fulltext" 的 chunk
  const rows = await db
    .select({ id: materialChunks.id, content: materialChunks.content })
    .from(materialChunks)
    .where(and(eq(materialChunks.materialId, materialId), eq(materialChunks.vectorId, "fulltext")));

  if (rows.length === 0) {
    console.log(`[Embed] 教材 ${materialId} 无需回填`);
    return;
  }

  console.log(`[Embed] 教材 ${materialId} 共 ${rows.length} 个 chunk 需要回填`);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const embeddings: Array<number[] | undefined> = new Array(batch.length).fill(undefined);

    const batched = await getEmbeddingsWithRetry(batch.map(r => r.content), 2);
    for (let j = 0; j < batched.length; j++) embeddings[j] = batched[j];

    for (let j = 0; j < batch.length; j++) {
      if (embeddings[j]) continue;
      embeddings[j] = await getEmbeddingWithRetry(batch[j].content, 2);
      if (!embeddings[j]) {
        console.warn(`[Embed] 块 ${batch[j].id} Embedding 生成失败，保持 fulltext`);
      }
    }

    await Promise.all(
      batch.map(async (row, batchIdx) => {
        const embedding = embeddings[batchIdx];
        if (!embedding) return;
        await db
          .update(materialChunks)
          .set({ embedding, vectorId: "embedded" })
          .where(eq(materialChunks.id, row.id));
      })
    );

    console.log(`[Embed] 教材 ${materialId} 已回填 ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
  }

  console.log(`[Embed] 教材 ${materialId} Embedding 回填完成`);
}
