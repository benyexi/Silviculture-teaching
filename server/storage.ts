/**
 * Local filesystem storage — replaces Manus Forge storage proxy.
 * Files are stored under UPLOAD_DIR (default: ./uploads/).
 * In Docker, this directory should be mounted as a volume for persistence.
 */

import fs from "node:fs";
import path from "node:path";
import { ENV } from "./_core/env";

function getUploadDir(): string {
  const dir = ENV.uploadDir || "./uploads";
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  _contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  const uploadDir = getUploadDir();
  const filePath = path.join(uploadDir, key);

  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write file
  const buffer = typeof data === "string" ? Buffer.from(data) : data;
  fs.writeFileSync(filePath, buffer);

  // Return a URL path that can be served by the app
  const url = `/uploads/${key}`;
  return { key, url };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  const uploadDir = getUploadDir();
  const filePath = path.join(uploadDir, key);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${key}`);
  }

  const url = `/uploads/${key}`;
  return { key, url };
}

/**
 * Read file content directly from local storage.
 * Used during upload finalization to read chunk data.
 */
export async function storageReadBuffer(relKey: string): Promise<Buffer> {
  const key = normalizeKey(relKey);
  const uploadDir = getUploadDir();
  const filePath = path.join(uploadDir, key);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${key}`);
  }

  return fs.readFileSync(filePath);
}
