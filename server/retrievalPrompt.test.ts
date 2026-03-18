import { beforeEach, describe, expect, it, vi } from "vitest";
import { materialChunks, materials } from "../drizzle/schema";
import { buildSystemPrompt, buildUserPrompt } from "./qaService";
import { extractKeywords, semanticSearch } from "./vectorSearch";

let semanticDb: any = null;

vi.mock("./db", () => ({
  getDb: vi.fn(async () => semanticDb),
  getActiveLlmConfig: vi.fn(async () => null),
  createQuery: vi.fn(),
  upsertVisitorStat: vi.fn(),
}));

function makeSemanticDb(
  chunkRows: Array<{
    id: number;
    materialId: number;
    chunkIndex: number;
    content: string;
    chapter: string | null;
    pageStart: number | null;
    pageEnd: number | null;
    embedding: number[] | null;
  }>,
  materialRows: Array<{ id: number; title: string }>
) {
  return {
    select(selector: Record<string, unknown> = {}) {
      const isChunkQuery = Object.prototype.hasOwnProperty.call(selector, "content");

      return {
        from(table: unknown) {
          const isChunkTable = table === materialChunks;
          const shouldReturnChunks = isChunkQuery || isChunkTable;

          return {
            innerJoin() {
              return this;
            },
            where() {
              if (shouldReturnChunks) {
                return {
                  limit() {
                    return Promise.resolve(chunkRows);
                  },
                };
              }
              return Promise.resolve(materialRows);
            },
            limit() {
              return Promise.resolve(chunkRows);
            },
          };
        },
      };
    },
  };
}

beforeEach(() => {
  semanticDb = null;
  vi.clearAllMocks();
});

describe("extractKeywords", () => {
  it("keeps list-style question terms and drops filler words", () => {
    const keywords = extractKeywords("树种选择有哪些分类、方法和步骤？");

    expect(keywords).toEqual(
      expect.arrayContaining(["分类", "方法", "步骤", "树种", "选择"])
    );
    expect(keywords).not.toContain("哪些");
  });

  it("retains method-oriented domain terms for silviculture questions", () => {
    const keywords = extractKeywords("混交林有哪些类型和方法？");

    expect(keywords).toEqual(expect.arrayContaining(["类型", "方法"]));
    expect(keywords.some((kw) => kw.includes("混交"))).toBe(true);
    expect(keywords).not.toContain("有哪些");
  });
});

describe("semanticSearch", () => {
  it("ranks the more complete method chunk above a partial match", async () => {
    semanticDb = makeSemanticDb(
      [
        {
          id: 11,
          materialId: 1,
          chunkIndex: 10,
          content:
            "混交方式包括株间混交、行间混交、带状混交、块状混交、星状混交、植生组混交和不规则混交。",
          chapter: "混交林类型与方法",
          pageStart: 12,
          pageEnd: 13,
          embedding: null,
        },
        {
          id: 12,
          materialId: 1,
          chunkIndex: 11,
          content: "混交方式可采用株间混交。",
          chapter: "混交林类型与方法",
          pageStart: 13,
          pageEnd: 13,
          embedding: null,
        },
        {
          id: 13,
          materialId: 1,
          chunkIndex: 30,
          content: "立地质量是林地对特定树种的综合生产潜力。",
          chapter: "立地质量",
          pageStart: 45,
          pageEnd: 46,
          embedding: null,
        },
      ],
      [{ id: 1, title: "森林培育学（第三版）" }]
    );

    const results = await semanticSearch("混交林有哪些类型和方法？", undefined, 3, "zh", false);

    expect(results.map((r) => r.chunkId)).toEqual([11, 12]);
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    expect(results[0].chapter).toBe("混交林类型与方法");
  });

  it("keeps the chunk that covers more procedural steps above a partial step list", async () => {
    semanticDb = makeSemanticDb(
      [
        {
          id: 21,
          materialId: 1,
          chunkIndex: 20,
          content:
            "树种选择的分类、方法和步骤通常包括分类、方法和步骤三部分。树种选择的分类需要结合立地条件，树种选择的方法需要结合适地适树，树种选择的步骤需要先调查、再比较、后确定。",
          chapter: "树种选择的分类、方法和步骤",
          pageStart: 18,
          pageEnd: 19,
          embedding: null,
        },
        {
          id: 22,
          materialId: 1,
          chunkIndex: 21,
          content: "树种选择一般要结合立地条件和适地适树原则。",
          chapter: "树种选择概述",
          pageStart: 20,
          pageEnd: 20,
          embedding: null,
        },
      ],
      [{ id: 1, title: "森林培育学（第三版）" }]
    );

    const results = await semanticSearch("树种选择有哪些分类、方法和步骤？", undefined, 2, "zh", false);

    expect(results.map((r) => r.chunkId)).toEqual([21, 22]);
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
  });
});

describe("prompt builders", () => {
  it("writes a structured system prompt for classification and method questions", () => {
    const prompt = buildSystemPrompt(["森林培育学（第三版）"], "zh", "zh");

    expect(prompt).toContain("回答协议");
    expect(prompt).toContain("分类、方法、步骤或比较题");
    expect(prompt).toContain("定义与概述→分类/类型→具体方法/步骤→原则与注意事项→应用场景");
    expect(prompt).toContain("示例1（分类题）");
    expect(prompt).toContain("示例2（方法题）");
    expect(prompt).toContain("禁止引用标记");
  });

  it("includes an explicit output skeleton in the user prompt", () => {
    const prompt = buildUserPrompt(
      "混交林有哪些类型和方法？",
      [
        {
          chunkId: 101,
          chunkIndex: 10,
          materialId: 1,
          materialTitle: "森林培育学（第三版）",
          chapter: "混交林类型与方法",
          pageStart: 12,
          pageEnd: 13,
          content: "混交方式包括株间混交、行间混交、带状混交。",
          similarity: 0.9,
        },
        {
          chunkId: 102,
          chunkIndex: 11,
          materialId: 1,
          materialTitle: "森林培育学（第三版）",
          chapter: "混交林类型与方法",
          pageStart: 14,
          pageEnd: 15,
          content: "另一段教材说明了块状混交和星状混交。",
          similarity: 0.8,
        },
      ],
      "zh"
    );

    expect(prompt).toContain("【学生问题】");
    expect(prompt).toContain("【教材内容片段（共 2 条）】");
    expect(prompt).toContain("【片段1】来源：《森林培育学（第三版）》 · 混交林类型与方法 · 第12页~13页");
    expect(prompt).toContain("【片段2】来源：《森林培育学（第三版）》 · 混交林类型与方法 · 第14页~15页");
    expect(prompt).toContain("不要遗漏任何片段中的相关信息");
    expect(prompt).toContain("请综合以上所有教材片段");
  });
});
