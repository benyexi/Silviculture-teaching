import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { runMigrations, getDb, getActiveLlmConfig } from "../db";
import { ENV } from "./env";
import { generateAnswerStream } from "../qaService";
import { semanticSearch } from "../vectorSearch";
import { getGeoInfo, extractIp } from "../geoip";
import { materials, materialChunks } from "../../drizzle/schema";
import { eq, like, and, count as drizzleCount } from "drizzle-orm";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // Run database migrations on startup to ensure tables exist
  try {
    await runMigrations();
    console.log("[Server] Database migrations completed");
  } catch (err) {
    console.error("[Server] Database migration failed (app will continue with degraded DB):", err);
  }

  const app = express();
  const server = createServer(app);
  // Trust proxy headers (Railway, Render, etc. use reverse proxies)
  app.set("trust proxy", 1);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // 大文件上传：延长 HTTP 超时到 10 分钟
  server.setTimeout(600_000);
  server.keepAliveTimeout = 120_000;
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // ─── 诊断端点：排查搜索问题 ──────────────────────────────────────
  app.get("/api/debug/search-diag", async (_req, res) => {
    try {
      const db = await getDb();
      if (!db) {
        res.json({ error: "Database not available", DATABASE_URL_SET: !!process.env.DATABASE_URL });
        return;
      }

      // 1. 检查 materials 表
      const allMaterials = await db.select({
        id: materials.id,
        title: materials.title,
        status: materials.status,
        language: materials.language,
        totalChunks: materials.totalChunks,
      }).from(materials);

      // 2. 检查 material_chunks 表总数
      const [chunkTotal] = await db.select({ count: drizzleCount() }).from(materialChunks);

      // 3. 检查 published 材料的 chunks 数
      const publishedMats = allMaterials.filter(m => m.status === "published");
      const publishedMatIds = publishedMats.map(m => m.id);

      let publishedChunkCount = 0;
      let sampleChunk: any = null;
      let likeTestResults: { term: string; count: number }[] = [];

      if (publishedMatIds.length > 0) {
        // 查 published 材料的 chunks
        for (const matId of publishedMatIds) {
          const [cnt] = await db.select({ count: drizzleCount() })
            .from(materialChunks)
            .where(eq(materialChunks.materialId, matId));
          publishedChunkCount += cnt.count;
        }

        // 取一个 sample chunk
        const samples = await db.select({
          id: materialChunks.id,
          materialId: materialChunks.materialId,
          chunkIndex: materialChunks.chunkIndex,
          content: materialChunks.content,
          chapter: materialChunks.chapter,
          vectorId: materialChunks.vectorId,
        }).from(materialChunks)
          .where(eq(materialChunks.materialId, publishedMatIds[0]))
          .limit(3);
        sampleChunk = samples.map(s => ({
          id: s.id,
          materialId: s.materialId,
          chunkIndex: s.chunkIndex,
          contentLength: s.content?.length ?? 0,
          contentPreview: s.content?.slice(0, 200) ?? "(null)",
          chapter: s.chapter,
          vectorId: s.vectorId,
        }));

        // 4. 测试 LIKE 查询 — 模拟关键词搜索
        const testTerms = ["森林", "培育", "密度", "林分", "造林"];
        for (const term of testTerms) {
          const [cnt] = await db.select({ count: drizzleCount() })
            .from(materialChunks)
            .innerJoin(materials, eq(materialChunks.materialId, materials.id))
            .where(and(
              eq(materials.status, "published"),
              eq(materials.language, "zh"),
              like(materialChunks.content, `%${term}%`)
            ));
          likeTestResults.push({ term, count: cnt.count });
        }
      }

      // 5. LLM 配置
      const config = await getActiveLlmConfig();

      res.json({
        database: "connected",
        materials: allMaterials.map(m => ({
          id: m.id,
          title: m.title,
          status: m.status,
          language: m.language,
          totalChunks: m.totalChunks,
        })),
        totalChunks: chunkTotal.count,
        publishedChunkCount,
        sampleChunks: sampleChunk,
        likeSearchTest: likeTestResults,
        llmConfig: config ? {
          id: config.id,
          name: config.name,
          useRAG: config.useRAG,
          isActive: config.isActive,
          embeddingModel: config.embeddingModel || "(not set)",
          provider: config.provider,
        } : null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  });

  // ─── 直接调用 semanticSearch 测试 ─────────────────────────────────
  app.get("/api/debug/search-test", async (req, res) => {
    const q = (req.query.q as string) || "什么是森林培育";
    try {
      const results = await semanticSearch(q, undefined, 5, "zh", true);
      res.json({
        question: q,
        resultCount: results.length,
        results: results.map(r => ({
          chunkId: r.chunkId,
          similarity: r.similarity,
          chapter: r.chapter,
          contentPreview: r.content.slice(0, 150),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  });

  // Auth routes (local login)
  registerOAuthRoutes(app);

  // Serve uploaded files — use ENV.uploadDir for consistency
  const uploadDir = ENV.uploadDir;
  app.use("/uploads", express.static(uploadDir));

  // SSE 流式问答端点
  app.post("/api/stream/ask", async (req, res) => {
    const { question, materialId } = req.body || {};
    if (!question || typeof question !== "string" || question.length < 2 || question.length > 1000) {
      res.status(400).json({ error: "问题长度需在 2-1000 字之间" });
      return;
    }
    if (materialId !== undefined && (!Number.isInteger(materialId) || materialId <= 0)) {
      res.status(400).json({ error: "materialId 必须是正整数" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Nginx 反向代理不缓冲
    res.flushHeaders();

    const ip = extractIp(req as any);
    const geo = await getGeoInfo(ip);

    let closed = false;
    req.on("close", () => { closed = true; });

    const sendSSE = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await generateAnswerStream(
        {
          question,
          materialIds: materialId ? [materialId] : undefined,
          visitorIp: ip,
          visitorCity: geo.city || undefined,
          visitorRegion: geo.region || undefined,
          visitorCountry: geo.country || undefined,
          visitorLat: geo.lat || undefined,
          visitorLng: geo.lng || undefined,
        },
        (meta) => sendSSE("meta", meta),
        (token) => sendSSE("token", { t: token }),
        (fullAnswer) => {
          sendSSE("done", { answer: fullAnswer });
          res.end();
        },
        (error) => {
          sendSSE("error", { message: error });
          res.end();
        }
      );
    } catch (err: any) {
      sendSSE("error", { message: err?.message || "未知错误" });
      res.end();
    }
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
