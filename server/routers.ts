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
  deleteChunksByMaterialId,
  updateMaterialStatus,
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
  getStorageStats,
  purgeOldQueries,
  purgeCompletedUploadSessions,
  clearAllEmbeddings,
} from "./db";
import { generateAnswer, clearAnswerCache } from "./qaService";
import { testLLMConnection } from "./llmDriver";
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
      const { storageExists } = await import("./storage");
      const mats = await getMaterials();
      return mats.map((m) => ({
        ...m,
        // 不暴露 fileKey 给前端，但告知文件是否存在
        hasFile: m.fileKey ? storageExists(m.fileKey) : false,
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
          language: z.enum(["zh", "en"]).optional(),
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
          language: z.enum(["zh", "en"]).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const session = await getUploadSession(input.sessionId);
        if (!session) throw new TRPCError({ code: "NOT_FOUND" });

        // 合并所有分块：流式写入目标文件，避免全部加载到内存
        const { storageGet: _get, storageReadBuffer } = await import("./storage");
        const fs = await import("node:fs");
        const path = await import("node:path");

        const { ENV } = await import("./_core/env");
        const uploadDir = ENV.uploadDir;
        const fileKey = `materials/${nanoid()}-${session.filename}`;
        const destPath = path.join(uploadDir, fileKey);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        // 流式合并：逐块追加写入，peak 内存只有一个 chunk 大小
        let totalSize = 0;
        const writeStream = fs.createWriteStream(destPath);
        for (let i = 0; i < session.totalChunks; i++) {
          const chunkKey = `uploads/chunks/${input.sessionId}/${i}`;
          const buf = await storageReadBuffer(chunkKey);
          totalSize += buf.length;
          await new Promise<void>((resolve, reject) => {
            writeStream.write(buf, (err) => err ? reject(err) : resolve());
          });
        }
        await new Promise<void>((resolve, reject) => {
          writeStream.end((err: Error | null) => err ? reject(err) : resolve());
        });

        const fileUrl = `/uploads/${fileKey}`;
        const ext = session.filename.toLowerCase().split(".").pop();

        // 创建教材记录
        const materialId = await createMaterial({
          title: input.title,
          author: input.author,
          publisher: input.publisher,
          publishYear: input.publishYear,
          edition: input.edition,
          language: input.language ?? "zh",
          fileKey,
          fileUrl,
          fileSizeBytes: totalSize,
          status: "processing",
          uploadedBy: ctx.user.id,
        });

        // 更新会话状态
        await updateUploadSession(input.sessionId, {
          status: "completed",
          materialId,
        });

        // 异步处理文档（读取完整文件用于解析）
        const fullBuffer = fs.readFileSync(destPath);
        processMaterial(materialId, fullBuffer, session.filename)
          .then(() => clearAnswerCache())
          .catch((err) => {
            console.error(`[Router] 教材 ${materialId} 处理失败:`, err);
          });

        // 清理临时分块文件
        const chunkDir = path.join(uploadDir, "uploads", "chunks", input.sessionId);
        fs.rm(chunkDir, { recursive: true, force: true }, (err) => {
          if (err) console.warn(`[Router] 清理临时文件失败:`, err);
        });

        return { materialId, status: "processing" };
      }),

    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const mat = await getMaterialById(input.id);
        if (!mat) throw new TRPCError({ code: "NOT_FOUND" });
        invalidateMaterialCache(input.id);
        clearAnswerCache(); // 教材删除后清空答案缓存
        await deleteMaterial(input.id);
        return { success: true };
      }),

    // 重新处理教材（删除旧 chunks，重新分块+索引）
    reprocess: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const mat = await getMaterialById(input.id);
        if (!mat) throw new TRPCError({ code: "NOT_FOUND", message: "教材不存在" });
        if (!mat.fileKey) throw new TRPCError({ code: "BAD_REQUEST", message: "教材文件不存在" });

        // 读取原始文件
        const { storageReadBuffer } = await import("./storage");
        let fileBuffer: Buffer;
        try {
          fileBuffer = await storageReadBuffer(mat.fileKey);
        } catch {
          throw new TRPCError({ code: "BAD_REQUEST", message: "教材原始文件已丢失，请重新上传" });
        }

        // 删除旧 chunks，更新状态为处理中
        await deleteChunksByMaterialId(input.id);
        await updateMaterialStatus(input.id, "processing");
        invalidateMaterialCache(input.id);

        // 提取文件名
        const filename = mat.fileKey.split("/").pop() || "document.pdf";

        // 异步重新处理
        processMaterial(input.id, fileBuffer, filename)
          .then(() => clearAnswerCache())
          .catch((err) => {
            console.error(`[Router] 教材 ${input.id} 重新处理失败:`, err);
          });

        return { status: "processing" };
      }),

    // 一键重新处理所有教材
    reprocessAll: adminProcedure
      .mutation(async () => {
        const { storageReadBuffer } = await import("./storage");
        const allMaterials = await getMaterials();
        const published = allMaterials.filter(m => m.status === "published" || m.status === "error");

        let started = 0;
        const failures: { title: string; reason: string }[] = [];
        for (const mat of published) {
          if (!mat.fileKey) {
            failures.push({ title: mat.title, reason: "原始文件路径缺失" });
            continue;
          }
          try {
            const fileBuffer = await storageReadBuffer(mat.fileKey);
            await deleteChunksByMaterialId(mat.id);
            await updateMaterialStatus(mat.id, "processing");
            invalidateMaterialCache(mat.id);
            const filename = mat.fileKey.split("/").pop() || "document.pdf";
            processMaterial(mat.id, fileBuffer, filename).catch((err) => {
              console.error(`[Router] 教材 ${mat.id} 重新处理失败:`, err);
            });
            started++;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.error(`[Router] 教材 ${mat.id} (${mat.title}) 文件读取失败:`, err);
            failures.push({ title: mat.title, reason });
          }
        }

        clearAnswerCache();
        return { started, total: published.length, failures };
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
        // 如果没有已激活的配置，自动激活新配置
        const active = await getActiveLlmConfig();
        const shouldActivate = !active;
        const id = await createLlmConfig({
          ...input,
          apiKey: input.apiKey?.trim(),
          embeddingApiKey: input.embeddingApiKey?.trim(),
          isActive: shouldActivate,
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
        if (data.apiKey) data.apiKey = data.apiKey.trim();
        if (data.embeddingApiKey) data.embeddingApiKey = data.embeddingApiKey.trim();
        await updateLlmConfig(id, data);
        clearAnswerCache(); // 配置变更后清空答案缓存
        return { success: true };
      }),

    setActive: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await setActiveLlmConfig(input.id);
        clearAnswerCache(); // 切换模型后清空答案缓存，确保使用新配置
        return { success: true };
      }),

    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deleteLlmConfig(input.id);
        return { success: true };
      }),

    /** 测试 LLM 连接是否正常 */
    testConnection: adminProcedure
      .input(z.object({
        provider: z.string(),
        modelName: z.string(),
        apiKey: z.string().optional(),
        apiBaseUrl: z.string().optional(),
        configId: z.number().optional(), // 编辑时传入，用于获取已存储的 key
      }))
      .mutation(async ({ input }) => {
        let apiKey = input.apiKey?.trim();
        // 编辑时如果没有输入新 key，从数据库获取已存储的 key
        if (!apiKey && input.configId) {
          const configs = await getLlmConfigs();
          const existing = configs.find((c) => c.id === input.configId);
          if (existing?.apiKey) apiKey = existing.apiKey;
        }
        if (!apiKey && input.provider !== "ollama") {
          return { success: false, message: "请输入 API Key" };
        }
        return testLLMConnection({
          provider: input.provider,
          modelName: input.modelName,
          apiKey: apiKey || null,
          apiBaseUrl: input.apiBaseUrl?.trim() || null,
        });
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

    /** 数据库存储统计 */
    storage: adminProcedure.query(async () => {
      return getStorageStats();
    }),

    /** 清理旧数据释放存储空间 */
    cleanup: adminProcedure
      .input(z.object({
        purgeQueriesOlderThanDays: z.number().min(7).max(365).optional(),
        purgeUploadSessions: z.boolean().optional(),
        clearEmbeddings: z.boolean().optional(),
      }))
      .mutation(async ({ input }) => {
        const result: Record<string, unknown> = {};
        if (input.purgeQueriesOlderThanDays) {
          result.queriesPurged = await purgeOldQueries(input.purgeQueriesOlderThanDays);
        }
        if (input.purgeUploadSessions) {
          result.sessionsPurged = await purgeCompletedUploadSessions();
        }
        if (input.clearEmbeddings) {
          await clearAllEmbeddings();
          result.embeddingsCleared = true;
        }
        return result;
      }),
  }),
});

export type AppRouter = typeof appRouter;
