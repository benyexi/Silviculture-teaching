/**
 * 文档处理管道
 * 上传 PDF/Word → 提取文本 → 智能分块（按章节/段落）→ 向量化 → 存储
 */
import { getDb } from "./db";
import { materials, materialChunks } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { storeChunkVector } from "./vectorSearch";
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
  /^(第[一二三四五六七八九十百零\d]+[章节篇部编]|[\d]+\.[\d]+[\s\S]{0,30}|[一二三四五六七八九十]+[、．.]\s*\S|Chapter\s+\d+|CHAPTER\s+\d+|Part\s+[IVX\d]+)/i;

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
    const chunks = splitIntoChunks(text, pageTexts);
    console.log(`[Doc] 分块完成，共 ${chunks.length} 个块`);

    // 3. 存储文本块到数据库 + 生成 Embedding
    console.log(`[Doc] 存储文本块并生成 Embedding...`);
    let embeddingEnabled = true;
    const BATCH_SIZE = 10;

    // 先测试 Embedding 是否可用
    try {
      await getEmbedding("test");
    } catch {
      embeddingEnabled = false;
      console.log(`[Doc] Embedding 未配置，仅使用全文检索模式`);
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

          const result = await db.insert(materialChunks).values({
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

          const chunkId = Number((result as any).insertId);
          if (!embedding) {
            await storeChunkVector(chunkId, []);
          }
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
const MAX_CHUNK_SIZE = 600;
const MIN_CHUNK_SIZE = 80;
const OVERLAP_SIZE = 120;

/** 在自然断句处切割文本，返回不超过 maxLen 的文本 */
function splitAtNaturalBoundary(text: string, maxLen: number): number {
  if (text.length <= maxLen) return text.length;

  // 优先在段落换行处切割
  const paragraphBreak = text.lastIndexOf("\n", maxLen);
  if (paragraphBreak > maxLen * 0.4) return paragraphBreak + 1;

  // 其次在句号/问号/感叹号处切割（中文+英文标点）
  // 从后往前找最后一个句子结束符
  let lastSentenceEnd = -1;
  const searchRange = text.substring(0, maxLen);
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
function splitTextWithOverlap(text: string, chapter: string | null): { content: string; overlapContent: string }[] {
  const results: { content: string; overlapContent: string }[] = [];
  const chapterPrefix = chapter ? `【${chapter}】\n` : "";
  // 实际可用的内容长度要减去章节前缀
  const effectiveMax = MAX_CHUNK_SIZE - chapterPrefix.length;

  let offset = 0;
  while (offset < text.length) {
    const remaining = text.substring(offset);
    if (remaining.trim().length < MIN_CHUNK_SIZE) break;

    const cutPos = splitAtNaturalBoundary(remaining, effectiveMax);
    const rawContent = remaining.substring(0, cutPos).trim();

    if (rawContent.length >= MIN_CHUNK_SIZE) {
      // chunk 正文带章节前缀
      const content = chapterPrefix + rawContent;
      results.push({ content, overlapContent: rawContent });
    }

    // 下一个 chunk 从 overlap 位置开始
    const advance = Math.max(cutPos - OVERLAP_SIZE, 1);
    offset += advance;

    // 如果剩余文本不多，直接结束避免产生过小的尾巴
    if (text.length - offset < MIN_CHUNK_SIZE) break;
  }

  return results;
}

function splitIntoChunks(text: string, pageTexts: string[]): TextChunk[] {
  const chunks: TextChunk[] = [];

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

        if (HEADING_PATTERN.test(line)) {
          // 遇到新标题，保存当前 section
          if (currentText.trim().length >= MIN_CHUNK_SIZE) {
            sections.push({
              chapter: currentChapter,
              text: currentText.trim(),
              pageStart: sectionPageStart,
              pageEnd: sectionPageEnd,
            });
          }
          currentChapter = line.substring(0, 100);
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
    if (currentText.trim().length >= MIN_CHUNK_SIZE) {
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

      if (HEADING_PATTERN.test(line)) {
        if (currentText.trim().length >= MIN_CHUNK_SIZE) {
          sections.push({ chapter: currentChapter, text: currentText.trim(), pageStart: null, pageEnd: null });
        }
        currentChapter = line.substring(0, 100);
        currentText = line + "\n";
      } else {
        currentText += line + "\n";
      }
    }
    if (currentText.trim().length >= MIN_CHUNK_SIZE) {
      sections.push({ chapter: currentChapter, text: currentText.trim(), pageStart: null, pageEnd: null });
    }
  }

  // 如果没有检测到任何 section（比如教材格式特殊），整体作为一个 section
  if (sections.length === 0 && text.trim().length >= MIN_CHUNK_SIZE) {
    sections.push({ chapter: null, text: text.trim(), pageStart: 1, pageEnd: pageTexts.length || null });
  }

  // 第二步：对每个 section 做带 overlap 的自然边界分块
  for (const section of sections) {
    const pieces = splitTextWithOverlap(section.text, section.chapter);
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

  return chunks.filter((c) => c.content.trim().length >= MIN_CHUNK_SIZE);
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
