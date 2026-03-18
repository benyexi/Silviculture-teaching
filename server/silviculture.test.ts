import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";

// ─── Mock 数据库模块 ──────────────────────────────────────────────────────────
vi.mock("./db", () => ({
  getMaterials: vi.fn().mockResolvedValue([
    {
      id: 1,
      title: "森林培育学（第三版）",
      author: "沈国舫",
      publisher: "中国林业出版社",
      publishYear: "2011",
      edition: "第三版",
      status: "published",
      totalChunks: 150,
      fileSizeBytes: 10485760,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    },
  ]),
  getMaterialById: vi.fn().mockResolvedValue({
    id: 1,
    title: "森林培育学（第三版）",
    status: "published",
    totalChunks: 150,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  }),
  createMaterial: vi.fn().mockResolvedValue(1),
  deleteMaterial: vi.fn().mockResolvedValue(undefined),
  updateMaterialStatus: vi.fn().mockResolvedValue(undefined),
  getLlmConfigs: vi.fn().mockResolvedValue([
    {
      id: 1,
      name: "DeepSeek Chat",
      provider: "deepseek",
      modelName: "deepseek-chat",
      apiKey: "sk-test1234",
      isActive: true,
      isDefault: false,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    },
  ]),
  getActiveLlmConfig: vi.fn().mockResolvedValue({
    id: 1,
    name: "DeepSeek Chat",
    provider: "deepseek",
    modelName: "deepseek-chat",
    isActive: true,
  }),
  createLlmConfig: vi.fn().mockResolvedValue(2),
  updateLlmConfig: vi.fn().mockResolvedValue(undefined),
  setActiveLlmConfig: vi.fn().mockResolvedValue(undefined),
  deleteLlmConfig: vi.fn().mockResolvedValue(undefined),
  getRecentQueries: vi.fn().mockResolvedValue([
    {
      id: 1,
      question: "什么是立地质量？",
      answer: "立地质量是指...",
      sources: [{ materialId: 1, materialTitle: "森林培育学", chapter: "第一章", pageStart: 10, pageEnd: 10, excerpt: "..." }],
      modelUsed: "deepseek-chat",
      responseTimeMs: 2500,
      visitorCity: "北京",
      createdAt: new Date("2024-01-15"),
    },
  ]),
  getQueryStats: vi.fn().mockResolvedValue({ total: 42, today: 5 }),
  getTopQuestions: vi.fn().mockResolvedValue([
    { question: "什么是立地质量？", count: 8 },
    { question: "如何进行树种选择？", count: 5 },
  ]),
  getMaterialUsageStats: vi.fn().mockResolvedValue([
    { id: 1, title: "森林培育学（第三版）", usageCount: 30 },
  ]),
  getVisitorStats: vi.fn().mockResolvedValue([
    {
      id: 1,
      date: "2024-01-15",
      totalVisitors: 12,
      totalQueries: 20,
      cityDistribution: { 北京: 5, 上海: 3, 广州: 4 },
      countryDistribution: { 中国: 12 },
    },
  ]),
  createUploadSession: vi.fn().mockResolvedValue("test-session-id"),
  getUploadSession: vi.fn().mockResolvedValue({
    id: "test-session-id",
    filename: "test.pdf",
    totalSize: 1024,
    totalChunks: 1,
    uploadedChunks: 0,
    status: "active",
    createdBy: 1,
  }),
  updateUploadSession: vi.fn().mockResolvedValue(undefined),
  upsertVisitorStat: vi.fn().mockResolvedValue(undefined),
  createQuery: vi.fn().mockResolvedValue(1),
}));

vi.mock("./qaService", () => ({
  generateAnswer: vi.fn().mockResolvedValue({
    answer: "立地质量是指林地对特定树种或林分生长的综合生产潜力。",
    sources: [
      {
        materialId: 1,
        materialTitle: "森林培育学（第三版）",
        chapter: "第三章 立地质量",
        pageStart: 45,
        pageEnd: 46,
        excerpt: "立地质量是指林地对特定树种...",
      },
    ],
    modelUsed: "deepseek-chat",
    responseTimeMs: 2100,
    queryId: 1,
  }),
}));

vi.mock("./vectorSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vectorSearch")>();
  return {
    ...actual,
    semanticSearch: vi.fn().mockResolvedValue([]),
    storeChunkVector: vi.fn().mockResolvedValue(undefined),
    invalidateMaterialCache: vi.fn(),
    forceRefreshCache: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./geoip", () => ({
  getGeoInfo: vi.fn().mockResolvedValue({
    ip: "127.0.0.1",
    city: "北京",
    region: "北京市",
    country: "中国",
    lat: 39.9042,
    lng: 116.4074,
  }),
  extractIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ key: "test-key", url: "https://example.com/test.pdf" }),
  storageGet: vi.fn().mockResolvedValue({ key: "test-key", url: "https://example.com/test.pdf" }),
  storageExists: vi.fn().mockReturnValue(true),
}));

// ─── 测试辅助函数 ─────────────────────────────────────────────────────────────
type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any,
    res: { clearCookie: vi.fn() } as any,
  };
}

function createUserContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 2,
    openId: "student-user",
    email: "student@bjfu.edu.cn",
    name: "张同学",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any,
    res: { clearCookie: vi.fn() } as any,
  };
}

function createAdminContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "admin-teacher",
    email: "xibeny@bjfu.edu.cn",
    name: "席本野",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any,
    res: { clearCookie: vi.fn() } as any,
  };
}

// ─── Auth 测试 ────────────────────────────────────────────────────────────────
describe("auth", () => {
  it("me returns null for unauthenticated user", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.auth.me();
    expect(result).toBeNull();
  });

  it("me returns user for authenticated user", async () => {
    const caller = appRouter.createCaller(createUserContext());
    const result = await caller.auth.me();
    expect(result).not.toBeNull();
    expect(result?.name).toBe("张同学");
  });

  it("logout clears session cookie", async () => {
    const ctx = createUserContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true });
    expect(ctx.res.clearCookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      expect.objectContaining({ maxAge: -1 })
    );
  });
});

// ─── QA 问答测试 ──────────────────────────────────────────────────────────────
describe("qa.ask", () => {
  it("returns answer with sources for valid question", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.qa.ask({ question: "什么是立地质量？" });
    expect(result.answer).toBeTruthy();
    expect(result.sources).toBeInstanceOf(Array);
    expect(result.modelUsed).toBeTruthy();
    expect(result.responseTimeMs).toBeGreaterThan(0);
  });

  it("rejects empty question", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    await expect(caller.qa.ask({ question: "a" })).rejects.toThrow();
  });

  it("rejects question exceeding 1000 chars", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    await expect(caller.qa.ask({ question: "x".repeat(1001) })).rejects.toThrow();
  });
});

// ─── 教材管理测试 ─────────────────────────────────────────────────────────────
describe("materials", () => {
  it("list returns materials for public users", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.materials.list();
    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].title).toBe("森林培育学（第三版）");
  });

  it("initUpload requires admin role", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(
      caller.materials.initUpload({
        filename: "test.pdf",
        totalSize: 1024,
        totalChunks: 1,
        title: "测试教材",
      })
    ).rejects.toThrow("需要教师权限");
  });

  it("initUpload succeeds for admin", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.materials.initUpload({
      filename: "test.pdf",
      totalSize: 1024,
      totalChunks: 1,
      title: "测试教材",
    });
    expect(result.sessionId).toBeTruthy();
  });

  it("delete requires admin role", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.materials.delete({ id: 1 })).rejects.toThrow("需要教师权限");
  });
});

// ─── LLM 配置测试 ─────────────────────────────────────────────────────────────
describe("llmConfig", () => {
  it("list requires admin role", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.llmConfig.list()).rejects.toThrow("需要教师权限");
  });

  it("list returns configs for admin", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.llmConfig.list();
    expect(result).toBeInstanceOf(Array);
    expect(result[0].name).toBe("DeepSeek Chat");
    // API key should be masked
    expect(result[0].apiKey).toMatch(/\.\.\./);
  });

  it("getActive returns active config for public users", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.llmConfig.getActive();
    expect(result).not.toBeNull();
    expect(result?.isActive).toBe(true);
  });

  it("create requires admin role", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(
      caller.llmConfig.create({
        name: "Test",
        provider: "deepseek",
        modelName: "deepseek-chat",
      })
    ).rejects.toThrow("需要教师权限");
  });

  it("setActive requires admin role", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.llmConfig.setActive({ id: 1 })).rejects.toThrow("需要教师权限");
  });
});

// ─── 统计测试 ─────────────────────────────────────────────────────────────────
describe("stats", () => {
  it("overview requires admin role", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.stats.overview()).rejects.toThrow("需要教师权限");
  });

  it("overview returns stats for admin", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.stats.overview();
    expect(result.queryStats.total).toBe(42);
    expect(result.queryStats.today).toBe(5);
    expect(result.topQuestions).toBeInstanceOf(Array);
    expect(result.materialUsage).toBeInstanceOf(Array);
    expect(result.visitorData).toBeInstanceOf(Array);
  });

  it("recentQueries requires admin role", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.stats.recentQueries({ limit: 10 })).rejects.toThrow("需要教师权限");
  });

  it("recentQueries returns query list for admin", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.stats.recentQueries({ limit: 10 });
    expect(result).toBeInstanceOf(Array);
    expect(result[0].question).toBe("什么是立地质量？");
  });
});

// ─── 关键词提取与同义词扩展测试 ───────────────────────────────────────────────
import { extractKeywords } from "./vectorSearch";

describe("extractKeywords", () => {
  it("extracts meaningful keywords from a simple question", () => {
    const kws = extractKeywords("造林密度如何确定？");
    expect(kws).toContain("造林密度");
    expect(kws).toContain("密度");
    expect(kws).toContain("确定");
    // Should NOT contain the question word itself as a single keyword
    expect(kws).not.toContain("如何");
  });

  it("extracts keywords from a complex question", () => {
    const kws = extractKeywords("什么是森林培育学？");
    expect(kws).toContain("森林");
    expect(kws).toContain("培育");
    expect(kws.some(k => k.includes("森林培育"))).toBe(true);
  });

  it("handles questions about tree species selection", () => {
    const kws = extractKeywords("树种选择的原则有哪些？");
    expect(kws).toContain("树种");
    expect(kws).toContain("选择");
    expect(kws).toContain("原则");
  });

  it("removes stop words from extracted keywords", () => {
    const kws = extractKeywords("什么是立地质量？");
    expect(kws).not.toContain("什么");
    expect(kws).not.toContain("是");
    expect(kws).toContain("立地");
    expect(kws).toContain("质量");
  });

  it("extracts English keywords", () => {
    const kws = extractKeywords("什么是silviculture？");
    expect(kws).toContain("silviculture");
  });
});
