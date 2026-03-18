import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

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
  const app = express();
  const server = createServer(app);
  // Trust proxy headers (Railway, Render, etc. use reverse proxies)
  app.set("trust proxy", 1);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Debug endpoint — visit /api/debug/auth in browser after login to diagnose cookie issues
  app.get("/api/debug/auth", async (req, res) => {
    const { parse: parseCookie } = await import("cookie");
    const { COOKIE_NAME } = await import("@shared/const");
    const { sdk } = await import("./sdk");

    const cookieHeader = req.headers.cookie;
    const cookies = cookieHeader ? parseCookie(cookieHeader) : {};
    const sessionCookie = cookies[COOKIE_NAME];
    let sessionResult: unknown = null;
    let dbUser: unknown = null;

    if (sessionCookie) {
      try {
        sessionResult = await sdk.verifySession(sessionCookie);
      } catch (e) {
        sessionResult = { error: String(e) };
      }

      if (sessionResult && typeof sessionResult === "object" && "openId" in (sessionResult as any)) {
        try {
          const { getUserByOpenId } = await import("../db");
          dbUser = await getUserByOpenId((sessionResult as any).openId);
        } catch (e) {
          dbUser = { error: String(e) };
        }
      }
    }

    res.json({
      hasCookieHeader: !!cookieHeader,
      cookieNames: Object.keys(cookies),
      hasSessionCookie: !!sessionCookie,
      sessionCookieLength: sessionCookie?.length ?? 0,
      jwtVerifyResult: sessionResult,
      dbUser_raw: dbUser,
      dbUser_keys: dbUser ? Object.keys(dbUser as any) : null,
      dbUser_type: typeof dbUser,
      dbUser_json: dbUser ? JSON.stringify(dbUser) : null,
      protocol: req.protocol,
      xForwardedProto: req.headers["x-forwarded-proto"],
      jwtSecretSet: !!(process.env.JWT_SECRET),
      jwtSecretLength: (process.env.JWT_SECRET ?? "").length,
    });
  });

  // Auth routes (local login)
  registerOAuthRoutes(app);

  // Serve uploaded files
  const uploadDir = process.env.UPLOAD_DIR || "./uploads";
  app.use("/uploads", express.static(uploadDir));

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
