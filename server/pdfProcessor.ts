/**
 * 文档处理管道
 * 上传 PDF/Word → 提取文本 → 智能分块（按章节/段落）→ 向量化 → 存储
 */
import { getDb, getActiveLlmConfig } from "./db";
import { materials, materialChunks } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { detectDocumentLanguage } from "./languageDetect";
import { getEmbedding } from "./llmDriver";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";

// ─── 文本块类型 ───────────────────────────────────────────────────────────────
type TextChunk = {
  content: string;
  chapter: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  tokenCount: number;
};

const HEADING_PATTERN =
  /^(第[一二三四五六七八九十百零\d]+[章节篇部编]|(?:\d+(?:\.\d+){1,5})\s*[^\d\s%][^\n]{0,60}|[一二三四五六七八九十]+[、．.]\s*\S|Chapter\s+\d+|CHAPTER\s+\d+|Part\s+[IVX\d]+)/i;

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

function normalizeChapterTitle(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!HEADING_PATTERN.test(trimmed)) return null;
  if (/^\d+(?:\.\d+){1,6}\s*$/.test(trimmed)) return null;
  if (/^\d+(?:\.\d+)?%\s*$/.test(trimmed)) return null;
  if (/^[\d.%\-]+$/.test(trimmed) && !/[\u4e00-\u9fa5a-z]/i.test(trimmed)) return null;
  return trimmed.substring(0, 100);
}

function isHeadingLine(line: string): boolean {
  return normalizeChapterTitle(line) !== null;
}

function isStructuralBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  return isHeadingLine(trimmed) || isListItemLine(trimmed);
}

function mergeSectionText(a: string, b: string): string {
  return `${a.trim()}\n${b.trim()}`.trim();
}

function mergeShortSections(
  sections: { chapter: string | null; text: string; pageStart: number | null; pageEnd: number | null }[],
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
      last.text = mergeSectionText(last.text, current.text);
      last.pageEnd = current.pageEnd ?? last.pageEnd;
      if (!last.chapter && current.chapter) last.chapter = current.chapter;
      continue;
    }

    merged.push(current);
  }

  if (merged.length > 1 && merged[merged.length - 1].text.length < minSize) {
    const tail = merged.pop();
    if (tail) {
      const prev = merged[merged.length - 1];
      if (prev) {
        prev.text = mergeSectionText(prev.text, tail.text);
        prev.pageEnd = tail.pageEnd ?? prev.pageEnd;
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

    if (line.length <= 36 && (isHeadingLine(line) || /[:：]$/.test(line))) {
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

    // 3. 存储文本块到数据库 + 按需生成 Embedding
    const activeConfig = await getActiveLlmConfig();
    const useRAG = activeConfig?.useRAG ?? false;

    let embeddingEnabled = useRAG; // 只有开启语义检索模式才尝试生成 Embedding
    const BATCH_SIZE = 10;

    if (!useRAG) {
      console.log(`[Doc] 当前为关键词检索模式，跳过 Embedding 生成`);
    } else {
      // 先测试 Embedding 是否可用
      try {
        await getEmbedding("test");
      } catch (err: any) {
        embeddingEnabled = false;
        const msg = err?.message || String(err);
        if (msg.includes("401") || msg.includes("Authentication") || msg.includes("invalid")) {
          console.warn(`[Doc] ⚠️ Embedding API Key 无效，降级为全文检索模式。请检查 API Key 配置。错误: ${msg}`);
        } else if (msg.includes("未配置")) {
          console.log(`[Doc] Embedding 未配置，仅使用全文检索模式`);
        } else {
          console.warn(`[Doc] Embedding 不可用（${msg}），降级为全文检索模式`);
        }
      }
    }

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (chunk, batchIdx) => {
          const idx = i + batchIdx;
          let embedding: number[] | undefined;

          // 生成 Embedding（如果已配置）
          if (embeddingEnabled) {
            try {
              embedding = await getEmbedding(chunk.content);
            } catch (err) {
              console.warn(`[Doc] 块 ${idx} Embedding 生成失败:`, err);
            }
          }

          await db.insert(materialChunks).values({
            materialId,
            chunkIndex: idx,
            content: chunk.content,
            chapter: chunk.chapter,
            pageStart: chunk.pageStart,
            pageEnd: chunk.pageEnd,
            tokenCount: chunk.tokenCount,
            embedding: embedding || undefined,
            vectorId: embedding ? "embedded" : "fulltext",
          });
        })
      );
      console.log(`[Doc] 已处理 ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length} 个块`);
    }

    // 5. 更新教材状态为已发布
    await db
      .update(materials)
      .set({ status: "published", totalChunks: chunks.length, language: detectedLanguage })
      .where(eq(materials.id, materialId));

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
    // 逐页回调，收集每页文本
    pagerender: (pageData: any) => {
      return pageData.getTextContent().then((textContent: any) => {
        const items: any[] = textContent.items || [];
        const pageText = items
          .map((item: any) => item.str || "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
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
    if (isHeadingLine(trimmed) && currentSection.trim().length > 100) {
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

    if (isHeadingLine(trimmed) && currentSection.trim().length > 100) {
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
): { content: string; overlapContent: string }[] {
  const results: { content: string; overlapContent: string }[] = [];
  const chapterPrefix = chapter ? `【${chapter}】\n` : "";
  const adjustedProfile = {
    ...profile,
    targetSize: Math.max(profile.targetSize - chapterPrefix.length, profile.minSize),
    maxSize: Math.max(profile.maxSize - chapterPrefix.length, profile.targetSize),
  };

  const blocks = splitIntoSemanticBlocks(text);
  if (blocks.length === 0) return [];

  let current = "";

  const emitCurrent = () => {
    const trimmed = current.trim();
    if (!trimmed) {
      current = "";
      return;
    }

    if (trimmed.length < adjustedProfile.minSize && results.length > 0) {
      const merged = mergeSectionText(results[results.length - 1].overlapContent, trimmed);
      results[results.length - 1] = {
        content: chapterPrefix + merged,
        overlapContent: merged,
      };
    } else {
      results.push({
        content: chapterPrefix + trimmed,
        overlapContent: trimmed,
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
          results[results.length - 1] = {
            content: chapterPrefix + merged,
            overlapContent: merged,
          };
        } else {
          results.push({
            content: chapterPrefix + trimmedPiece,
            overlapContent: trimmedPiece,
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
  type Section = { chapter: string | null; text: string; pageStart: number | null; pageEnd: number | null };
  const sections: Section[] = [];

  if (pageTexts.length > 0) {
    let currentChapter: string | null = null;
    let currentText = "";
    let sectionPageStart: number | null = 1;
    let sectionPageEnd: number | null = 1;

    for (let pageIdx = 0; pageIdx < pageTexts.length; pageIdx++) {
      const pageText = pageTexts[pageIdx].trim();
      if (!pageText) continue;
      const pageNum = pageIdx + 1;

      const lines = pageText.split("\n");
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const chapterTitle = normalizeChapterTitle(line);
        if (chapterTitle) {
          // 遇到新标题，保存当前 section
          if (currentText.trim().length >= sectionThreshold) {
            sections.push({
              chapter: currentChapter,
              text: currentText.trim(),
              pageStart: sectionPageStart,
              pageEnd: sectionPageEnd,
            });
          }
          currentChapter = chapterTitle;
          currentText = line + "\n";
          sectionPageStart = pageNum;
          sectionPageEnd = pageNum;
        } else {
          currentText += line + "\n";
          sectionPageEnd = pageNum;
        }
      }
    }
    // 最后一个 section
    if (currentText.trim().length >= sectionThreshold) {
      sections.push({
        chapter: currentChapter,
        text: currentText.trim(),
        pageStart: sectionPageStart,
        pageEnd: sectionPageEnd,
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

      const chapterTitle = normalizeChapterTitle(line);
      if (chapterTitle) {
        if (currentText.trim().length >= sectionThreshold) {
          sections.push({ chapter: currentChapter, text: currentText.trim(), pageStart: null, pageEnd: null });
        }
        currentChapter = chapterTitle;
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
      chunks.push({
        content: piece.content,
        chapter: section.chapter,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
        tokenCount: estimateTokens(piece.content),
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
