export const ENV = {
  appId: process.env.VITE_APP_ID ?? "silviculture-teaching",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  // Admin credentials for local auth
  adminUsername: process.env.ADMIN_USERNAME ?? "admin",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  // Upload directory for local file storage
  // In production (Railway), always use /data/uploads where the volume is mounted
  uploadDir: process.env.NODE_ENV === "production" ? "/data/uploads" : (process.env.UPLOAD_DIR ?? "./uploads"),
};
