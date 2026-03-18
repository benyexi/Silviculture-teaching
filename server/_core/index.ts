import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { runMigrations } from "../db";
import { ENV } from "./env";
import { generateAnswerStream } from "../qaService";
import { getGeoInfo, extractIp } from "../geoip";

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

  // Auth routes (local login)
  registerOAuthRoutes(app);

  // Serve uploaded files — use ENV.uploadDir for consistency
  const uploadDir = ENV.uploadDir;
  app.use("/uploads", express.static(uploadDir));

  // SSE 流式问答端点
  app.post("/api/stream/ask", async (req, res) => {
    const { question } = req.body || {};
    if (!question || typeof question !== "string" || question.length < 2 || question.length > 1000) {
      res.status(400).json({ error: "问题长度需在 2-1000 字之间" });
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
