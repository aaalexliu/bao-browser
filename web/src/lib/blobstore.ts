import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export async function putPng(key: string, bytes: Buffer): Promise<void> {
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) {
    const { put } = await import("@vercel/blob");
    await put(key, bytes, {
      access: "private",
      contentType: "image/png",
      addRandomSuffix: false,
      allowOverwrite: true,
      ...(process.env.BLOB_READ_WRITE_TOKEN ? { token: process.env.BLOB_READ_WRITE_TOKEN } : {}),
    });
    return;
  }
  const file = localPath(key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

export async function getPng(key: string): Promise<Buffer | null> {
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) {
    const { get } = await import("@vercel/blob");
    const result = await get(key, {
      access: "private",
      ...(process.env.BLOB_READ_WRITE_TOKEN ? { token: process.env.BLOB_READ_WRITE_TOKEN } : {}),
    });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }
  try {
    return readFileSync(/*turbopackIgnore: true*/ localPath(key));
  } catch {
    return null;
  }
}

function localPath(key: string): string {
  if (key.includes("..") || key.startsWith("/") || key.includes("\\")) throw new Error("bad blob key");
  const override = process.env.BAO_BLOB_DIR;
  if (override) return path.join(/*turbopackIgnore: true*/ override, key);
  return path.join(process.cwd(), ".data", "blobs", key);
}
