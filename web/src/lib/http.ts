import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SyncRejected } from "./guard";
import { HttpError, boot, principalFrom, type Principal } from "./registry";

export async function actor(req: Request): Promise<Principal | null> {
  await boot();
  const jar = await cookies();
  return principalFrom(req.headers.get("authorization"), jar.get("bao_session")?.value);
}

export function fail(err: unknown) {
  if (err instanceof SyncRejected) return NextResponse.json({ error: err.message }, { status: 400 });
  if (err instanceof HttpError) {
    const current = (err as HttpError & { current?: unknown }).current;
    return NextResponse.json({ error: err.message, ...(err.detail || {}), ...(current ? { current } : {}) }, { status: err.status });
  }
  console.error(err);
  return NextResponse.json({ error: err instanceof Error ? err.message : "error" }, { status: 500 });
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  }
  if (type.includes("form")) {
    const form = await req.formData();
    const out: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }
  return {};
}

export function formPost(req: Request): boolean {
  return (req.headers.get("content-type") || "").includes("form");
}

export function answersFrom(body: Record<string, unknown>): Record<string, unknown> {
  if (body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)) {
    return body.answers as Record<string, unknown>;
  }
  const answers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith("a_")) answers[key.slice(2)] = value;
  }
  return answers;
}

export function session(res: NextResponse, token: string) {
  res.cookies.set("bao_session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

export async function requireUser(req: Request): Promise<Principal> {
  const principal = await actor(req);
  if (!principal) throw new HttpError("sign in", 401);
  return principal;
}
