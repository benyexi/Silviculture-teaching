import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";
import { ENV } from "./env";

/**
 * Local authentication: username/password login for admin (teacher).
 * Students access the Q&A page without login.
 */
export function registerOAuthRoutes(app: Express) {
  // POST /api/auth/login — local username/password login
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { username, password } = req.body ?? {};

    if (!username || !password) {
      res.status(400).json({ error: "用户名和密码不能为空" });
      return;
    }

    if (!ENV.adminPassword) {
      res.status(500).json({ error: "管理员密码未配置，请设置 ADMIN_PASSWORD 环境变量" });
      return;
    }

    if (username !== ENV.adminUsername || password !== ENV.adminPassword) {
      res.status(401).json({ error: "用户名或密码错误" });
      return;
    }

    try {
      const openId = `local_${username}`;

      await db.upsertUser({
        openId,
        name: username,
        email: null,
        loginMethod: "local",
        role: "admin",
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(openId, {
        name: username,
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      res.json({ success: true, user: { name: username, role: "admin" } });
    } catch (error) {
      console.error("[Auth] Login failed", error);
      res.status(500).json({ error: "登录失败" });
    }
  });

  // Keep the OAuth callback for backwards compatibility (returns helpful error)
  app.get("/api/oauth/callback", (_req: Request, res: Response) => {
    res.status(410).json({
      error: "OAuth 已停用，请使用本地登录 POST /api/auth/login",
    });
  });
}
