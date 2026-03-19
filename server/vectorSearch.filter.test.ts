import { beforeEach, describe, expect, it, vi } from "vitest";
import { materialChunks, materials } from "../drizzle/schema";
import { assessNoiseCandidate, semanticSearch } from "./vectorSearch";

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

describe("assessNoiseCandidate", () => {
  it.each(["65.0%", "10.706", "3"])("drops numeric chapter noise: %s", (chapter) => {
    expect(assessNoiseCandidate("造林密度是指单位面积上的栽植株数。", chapter)).toMatchObject({
      drop: true,
      penalty: 0,
    });
  });

  it.each(["复习思考题", "思考题", "习题", "参考文献"])("drops section-prefix noise: %s", (prefix) => {
    expect(assessNoiseCandidate(`${prefix}\n1. 造林密度\n2. 林分密度`, "造林密度")).toMatchObject({
      drop: true,
      penalty: 0,
    });
  });

  it("drops directory-style outline with short consecutive numbered lines", () => {
    const content = [
      "1. 造林概述",
      "2. 造林任务",
      "3. 造林方法",
      "4. 造林步骤",
      "5. 造林要求",
    ].join("\n");

    expect(assessNoiseCandidate(content, "第1节")).toMatchObject({
      drop: true,
      penalty: 0,
    });
  });

  it("keeps boundary-safe chapters and non-directory prose", () => {
    expect(assessNoiseCandidate("第10章 造林密度", "第10章")).toMatchObject({
      drop: false,
      penalty: 1,
    });

    expect(
      assessNoiseCandidate(
        ["1. 造林密度是指单位面积上的栽植株数。", "正文继续说明方法和适地适树原则。"].join("\n"),
        "造林密度"
      )
    ).toMatchObject({
      drop: false,
    });
  });
});

describe("semanticSearch", () => {
  it("prefers definition sentences over historical narration for definition queries", async () => {
    semanticDb = makeSemanticDb(
      [
        {
          id: 101,
          materialId: 1,
          chunkIndex: 10,
          content: "造林密度是指在单位面积上栽植的株数。",
          chapter: "造林密度定义",
          pageStart: 12,
          pageEnd: 12,
          embedding: null,
        },
        {
          id: 102,
          materialId: 1,
          chunkIndex: 11,
          content:
            "造林密度在我国林业生产中经历了长期发展。早在传统经营时期，不同地区的经营者就不断调整配置方式。",
          chapter: "造林密度历史沿革",
          pageStart: 13,
          pageEnd: 14,
          embedding: null,
        },
      ],
      [{ id: 1, title: "森林培育学（第三版）" }]
    );

    const results = await semanticSearch("什么是造林密度？", undefined, 2, "zh", false);

    expect(results.map((r) => r.chunkId)).toEqual([101, 102]);
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
  });
});
