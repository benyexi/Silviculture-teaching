/**
 * PDF 处理管道
 * 上传 PDF → 提取文本 → 智能分块（按章节/段落）→ 向量化 → 存储
 */
import { getDb } from "./db";
import { materials, materialChunks } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { storeChunkVector } from "./vectorSearch";

// ─── 文本块类型 ───────────────────────────────────────────────────────────────
type TextChunk = {
  content: string;
  chapter: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  tokenCount: number;
};

const HEADING_PATTERN =
  /^(第[一二三四五六七八九十百\d]+[章节]|[\d]+\.[\d]+[\s\S]{0,30}|[一二三四五六七八九十]+[、．])/;

// ─── 主处理函数 ───────────────────────────────────────────────────────────────
export async function processMaterial(
  materialId: number,
  pdfBuffer: Buffer
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");

  try {
    // 更新状态为处理中
    await db
      .update(materials)
      .set({ status: "processing" })
      .where(eq(materials.id, materialId));

    // 1. 提取 PDF 文本
    console.log(`[PDF] 开始提取教材 ${materialId} 的文本...`);
    const { text, pageTexts } = await extractPdfText(pdfBuffer);

    // 2. 智能分块
    console.log(`[PDF] 开始分块，总文本长度: ${text.length} 字符`);
    const chunks = splitIntoChunks(text, pageTexts);
    console.log(`[PDF] 分块完成，共 ${chunks.length} 个块`);

    // 3. 存储文本块到数据库
    const insertedChunks: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = await db.insert(materialChunks).values({
        materialId,
        chunkIndex: i,
        content: chunk.content,
        chapter: chunk.chapter,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        tokenCount: chunk.tokenCount,
      });
      insertedChunks.push(Number((result as any).insertId));
    }

    // 4. 全文检索模式：标记所有 chunks 为已处理（无需向量化）
    console.log(`[PDF] 全文检索模式，标记 ${insertedChunks.length} 个块为已处理...`);
    const BATCH_SIZE = 50;
    for (let i = 0; i < insertedChunks.length; i += BATCH_SIZE) {
      const batchIds = insertedChunks.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batchIds.map(async (chunkId) => {
          try {
            await storeChunkVector(chunkId, []); // fulltext 模式，vector 为空数组
          } catch (err) {
            console.error(`[PDF] 标记块 ${chunkId} 失败:`, err);
          }
        })
      );
    }

    // 5. 更新教材状态为已发布
    await db
      .update(materials)
      .set({ status: "published", totalChunks: chunks.length })
      .where(eq(materials.id, materialId));

    console.log(`[PDF] 教材 ${materialId} 处理完成！`);
  } catch (error) {
    console.error(`[PDF] 教材 ${materialId} 处理失败:`, error);
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

// ─── 智能文本分块 ─────────────────────────────────────────────────────────────
function splitIntoChunks(text: string, pageTexts: string[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  const MAX_CHUNK_SIZE = 800;
  const MIN_CHUNK_SIZE = 50;

  const splitByHeading = (input: string, maxChunkSize = 800): string[] => {
    const lines = input.split("\n");
    const localChunks: string[] = [];
    let currentChunk = "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const isHeading = HEADING_PATTERN.test(line);
      if (isHeading && currentChunk.trim().length > 100) {
        localChunks.push(currentChunk.trim());
        currentChunk = `${line}\n`;
      } else if (currentChunk.length + line.length > maxChunkSize) {
        if (currentChunk.trim()) localChunks.push(currentChunk.trim());
        currentChunk = `${line}\n`;
      } else {
        currentChunk += `${line}\n`;
      }
    }

    if (currentChunk.trim()) localChunks.push(currentChunk.trim());

    const merged: string[] = [];
    for (const c of localChunks.filter((c) => c.length >= MIN_CHUNK_SIZE)) {
      const last = merged[merged.length - 1];
      if (last && last.length < 120 && last.length + c.length <= maxChunkSize) {
        merged[merged.length - 1] = `${last}\n${c}`;
      } else {
        merged.push(c);
      }
    }
    return merged;
  };

  if (pageTexts.length > 0) {
    let currentChapter: string | null = null;

    for (let pageIdx = 0; pageIdx < pageTexts.length; pageIdx++) {
      const pageText = pageTexts[pageIdx].trim();
      if (!pageText) continue;

      const pageNum = pageIdx + 1;
      const pageChunks = splitByHeading(pageText, MAX_CHUNK_SIZE);

      for (const piece of pageChunks) {
        const firstLine = piece.split("\n")[0]?.trim() || "";
        if (HEADING_PATTERN.test(firstLine)) {
          currentChapter = firstLine.substring(0, 100);
        }

        chunks.push({
          content: piece,
          chapter: currentChapter,
          pageStart: pageNum,
          pageEnd: pageNum,
          tokenCount: estimateTokens(piece),
        });
      }
    }
  } else {
    const fullChunks = splitByHeading(text, MAX_CHUNK_SIZE);
    for (const piece of fullChunks) {
      const firstLine = piece.split("\n")[0]?.trim() || "";
      chunks.push({
        content: piece,
        chapter: HEADING_PATTERN.test(firstLine) ? firstLine.substring(0, 100) : null,
        pageStart: null,
        pageEnd: null,
        tokenCount: estimateTokens(piece),
      });
    }
  }

  return chunks.filter((c) => c.content.trim().length >= MIN_CHUNK_SIZE);
}

// ─── 滑动窗口分割 ─────────────────────────────────────────────────────────────
function slidingWindowSplit(
  text: string,
  maxSize: number,
  overlap: number
): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxSize, text.length);
    chunks.push(text.slice(start, end));
    start += maxSize - overlap;
    if (start >= text.length) break;
  }
  return chunks;
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
