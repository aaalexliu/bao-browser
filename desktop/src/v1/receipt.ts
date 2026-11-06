// Append-only read-back receipts. Each line is one receipt.
// The hash covers the canonical body, including the previous hash, so a later
// signer can cover the same bytes. This file is never rewritten.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonical } from "./canonical";
import type { ReadBack } from "./schema";

export interface Receipt {
  kind: "read-back";
  ts: number;
  runId: string;
  workflowId: string;
  stepId: string;
  source: ReadBack["source"];
  expected: string;
  actual: string;
  pass: boolean;
  prev: string;
  hash: string;
}

export type ReceiptBody = Omit<Receipt, "prev" | "hash">;

export function hashReceipt(body: Omit<Receipt, "hash">): string {
  return createHash("sha256").update(canonical(body)).digest("hex");
}

export function verifyReceiptChain(receipts: Receipt[]): boolean {
  let prev = "";
  for (const receipt of receipts) {
    if (receipt.prev !== prev) return false;
    const { hash, ...body } = receipt;
    if (hashReceipt(body) !== hash) return false;
    prev = hash;
  }
  return true;
}

/** Read a file only when it lives under the throwaway temp directory. */
export function readThrowaway(filePath: string): string {
  const resolved = path.resolve(filePath);
  const root = path.resolve(tmpdir());
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("read-back file is not a throwaway path");
  }
  return readFileSync(resolved, "utf8");
}

export class ReceiptLog {
  readonly entries: Receipt[] = [];
  private prev = "";

  constructor(private readonly file?: string) {
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      const lines = readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
      const last = lines.at(-1);
      if (last) {
        const parsed = JSON.parse(last) as Receipt;
        if (parsed.hash) this.prev = parsed.hash;
      }
    } catch {
      /* first receipt in this file */
    }
  }

  append(body: ReceiptBody): Receipt {
    const withPrev = { ...body, prev: this.prev };
    const receipt: Receipt = { ...withPrev, hash: hashReceipt(withPrev) };
    if (this.file) appendFileSync(this.file, `${canonical(receipt)}\n`);
    this.entries.push(receipt);
    this.prev = receipt.hash;
    return receipt;
  }
}
