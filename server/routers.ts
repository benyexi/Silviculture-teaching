import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import {
  getMaterials,
  getMaterialById,
  createMaterial,
  deleteMaterial,
  getLlmConfigs,
  getActiveLlmConfig,
  createLlmConfig,
  updateLlmConfig,
  setActiveLlmConfig,
  deleteLlmConfig,
  getRecentQueries,
  getQueryStats,
  getTopQuestions,
  getMaterialUsageStats,
  getVisitorStats,
  submitQueryFeedback,
  getLowRatedQuestions,
  createUploadSession,
  getUploadSession,
  updateUploadSession,
} from "./db";
import { generateAnswer } from "./qaService";
import { processMaterial } from "./pdfProcessor";
import { invalidateMaterialCache } from "./vectorSearch";
import { getGeoInfo, extractIp } from "./geoip";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";

// ─── 管理员权限中间件 ─────────────────────────────────────────────────────────
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "需要教师权限" });
  }
  return next({ ctx });
});

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ─── 问答（学生端）──────────────────────────────────────────────────────────
  qa: router({
    ask: publicProcedure
      .input(z.object({ question: z.string().min(2).max(1000) }))
      .mutation(async ({ input, ctx }) => {
        const ip = extractIp(ctx.req as any);
        const geo = await getGeoInfo(ip);

        return generateAnswer({
          question: input.question,
          visitorIp: ip,
          visitorCity: geo.city || undefined,
          visitorRegion: geo.region || undefined,
          visitorCountry: geo.country || undefined,
          visitorLat: geo.lat || undefined,
          visitorLng: geo.lng || undefined,
        });
      }),

    submitFeedback: publicProcedure
      .input(z.object({ queryId: z.number(), helpful: z.boolean() }))
      .mutation(async ({ input }) => {
        await submitQueryFeedback(input.queryId, input.helpful);
        return { success: true };
      }),

    getLowRatedQuestions: protectedProcedure
      .query(async ({ ctx }) => {
        if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
        return await getLowRatedQuestions();
      }),
  }),

  // ─── 教材管理（教师端）──────────────────────────────────────────────────────
  materials: router({
    list: publicProcedure.query(async () => {
      const mats = await getMaterials();
      return mats.map((m) => ({
        ...m,
        // 不暴露 fileKey 给前端
        fileKey: undefined,
      }));
    }),

    getById: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const mat = await getMaterialById(input.id);
        if (!mat) throw new TRPCError({ code: "NOT_FOUND" });
        return { ...mat, fileKey: undefined };
      }),

    // 初始化上传会话（大文件分块上传）
    initUpload: adminProcedure
      .input(
        z.object({
          filename: z.string(),
          totalSize: z.number(),
          totalChunks: z.number(),
          title: z.string().min(1),
          author: z.string().optional(),
          publisher: z.string().optional(),
          publishYear: z.string().optional(),
          edition: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const sessionId = nanoid();
        await createUploadSession({
          id: sessionId,
          filename: input.filename,
          totalSize: input.totalSize,
          totalChunks: input.totalChunks,
          uploadedChunks: 0,
          status: "active",
          createdBy: ctx.user.id,
        });
        return { sessionId };
      }),

    // 上传单个分块
    uploadChunk: adminProcedure
      .input(
        z.object({
          sessionId: z.string(),
          chunkIndex: z.number(),
          chunkData: z.string(), // base64 编码
          isLastChunk: z.boolean(),
          // 教材元数据（仅最后一块需要）
          title: z.string().optional(),
          author: z.string().optional(),
          publisher: z.string().optional(),
          publishYear: z.string().optional(),
          edition: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const session = await getUploadSession(input.sessionId);
        if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "上传会话不存在" });
        if (session.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "上传会话已结束" });

        // 存储分块到临时 S3 路径
        const chunkBuffer = Buffer.from(input.chunkData, "base64");
        const chunkKey = `uploads/chunks/${input.sessionId}/${input.chunkIndex}`;
        await storagePut(chunkKey, chunkBuffer, "application/octet-stream");

        const uploadedChunks = (session.uploadedChunks || 0) + 1;
        await updateUploadSession(input.sessionId, { uploadedChunks });

        if (input.isLastChunk) {
          // 所有分块上传完成，合并并处理
          return { status: "merging", sessionId: input.sessionId };
        }

        return { status: "chunk_uploaded", uploadedChunks, sessionId: input.sessionId };
      }),

    // 完成上传并触发处理
    finalizeUpload: adminProcedure
      .input(
        z.object({
          sessionId: z.string(),
          title: z.string().min(1),
          author: z.string().optional(),
          publisher: z.string().optional(),
          publishYear: z.string().optional(),
          edition: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const session = await getUploadSession(input.sessionId);
        if (!session) throw new TRPCError({ code: "NOT_FOUND" });

        // 合并所有分块（从 S3 读取并拼接）
        const { storagePut: put, storageGet } = await import("./storage");
        const chunks: Buffer[] = [];

        for (let i = 0; i < session.totalChunks; i++) {
          const chunkKey = `uploads/chunks/${input.sessionId}/${i}`;
          const { url } = await storageGet(chunkKey);
          const resp = await fetch(url);
          const buf = Buffer.from(await resp.arrayBuffer());
          chunks.push(buf);
        }

        const fullBuffer = Buffer.concat(chunks);

        // 上传完整文件到 S3
        const fileKey = `materials/${nanoid()}-${session.filename}`;
        const { url: fileUrl } = await put(fileKey, fullBuffer, "application/pdf");

        // 创建教材记录
        const materialId = await createMaterial({
          title: input.title,
          author: input.author,
          publisher: input.publisher,
          publishYear: input.publishYear,
          edition: input.edition,
          fileKey,
          fileUrl,
          fileSizeBytes: fullBuffer.length,
          status: "processing",
          uploadedBy: ctx.user.id,
        });

        // 更新会话状态
        await updateUploadSession(input.sessionId, {
          status: "completed",
          materialId,
        });

        // 异步处理 PDF（不阻塞响应）
        processMaterial(materialId, fullBuffer).catch((err) => {
          console.error(`[Router] 教材 ${materialId} 处理失败:`, err);
        });

        return { materialId, status: "processing" };
      }),

    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const mat = await getMaterialById(input.id);
        if (!mat) throw new TRPCError({ code: "NOT_FOUND" });
        invalidateMaterialCache(input.id);
        await deleteMaterial(input.id);
        return { success: true };
      }),
  }),

  // ─── LLM 配置（教师端）──────────────────────────────────────────────────────
  llmConfig: router({
    list: adminProcedure.query(async () => {
      const configs = await getLlmConfigs();
      // 脱敏处理：不返回完整 API Key
      return configs.map((c) => ({
        ...c,
        apiKey: c.apiKey ? `${c.apiKey.substring(0, 8)}...` : null,
        embeddingApiKey: c.embeddingApiKey ? `${c.embeddingApiKey.substring(0, 8)}...` : null,
      }));
    }),

    getActive: publicProcedure.query(async () => {
      const config = await getActiveLlmConfig();
      if (!config) return null;
      return {
        id: config.id,
        name: config.name,
        provider: config.provider,
        modelName: config.modelName,
        isActive: config.isActive,
      };
    }),

    create: adminProcedure
      .input(
        z.object({
          name: z.string().min(1),
          provider: z.enum(["openai", "deepseek", "qwen", "ollama", "custom"]),
          modelName: z.string().min(1),
          apiKey: z.string().optional(),
          apiBaseUrl: z.string().optional(),
          temperature: z.number().min(0).max(2).optional(),
          maxTokens: z.number().min(100).max(32000).optional(),
          embeddingModel: z.string().optional(),
          embeddingApiKey: z.string().optional(),
          embeddingBaseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const id = await createLlmConfig({
          ...input,
          isActive: false,
          isDefault: false,
        });
        return { id };
      }),

    update: adminProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          modelName: z.string().optional(),
          apiKey: z.string().optional(),
          apiBaseUrl: z.string().optional(),
          temperature: z.number().min(0).max(2).optional(),
          maxTokens: z.number().min(100).max(32000).optional(),
          embeddingModel: z.string().optional(),
          embeddingApiKey: z.string().optional(),
          embeddingBaseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await updateLlmConfig(id, data);
        return { success: true };
      }),

    setActive: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await setActiveLlmConfig(input.id);
        return { success: true };
      }),

    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deleteLlmConfig(input.id);
        return { success: true };
      }),
  }),

  // ─── 统计（教师端）──────────────────────────────────────────────────────────
  stats: router({
    overview: adminProcedure.query(async () => {
      const [queryStats, topQuestions, materialUsage, visitorData] = await Promise.all([
        getQueryStats(),
        getTopQuestions(10),
        getMaterialUsageStats(),
        getVisitorStats(30),
      ]);
      return { queryStats, topQuestions, materialUsage, visitorData };
    }),

    recentQueries: adminProcedure
      .input(z.object({ limit: z.number().min(1).max(200).default(50) }))
      .query(async ({ input }) => {
        return getRecentQueries(input.limit);
      }),
  }),
});

export type AppRouter = typeof appRouter;
