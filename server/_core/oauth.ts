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

    console.log("[Auth] Login attempt:", { username, bodyKeys: Object.keys(req.body ?? {}), envUser: ENV.adminUsername, envPassSet: !!ENV.adminPassword });

    if (!username || !password) {
      res.status(400).json({ error: "用户名和密码不能为空" });
      return;
    }

    if (!ENV.adminPassword) {
      res.status(500).json({ error: "管理员密码未配置，请设置 ADMIN_PASSWORD 环境变量" });
      return;
    }

    // Trim whitespace to handle copy-paste issues in environment variables
    const envUsername = ENV.adminUsername.trim();
    const envPassword = ENV.adminPassword.trim();

    if (username !== envUsername || password !== envPassword) {
      console.log("[Auth] Login failed - mismatch:", {
        usernameMatch: username === envUsername,
        passwordMatch: password === envPassword,
        inputUserLen: username.length,
        envUserLen: envUsername.length,
        inputPassLen: password.length,
        envPassLen: envPassword.length,
      });
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
