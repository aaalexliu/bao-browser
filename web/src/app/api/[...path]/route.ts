import { dispatch } from "@/lib/dispatch";

export const dynamic = "force-dynamic";

async function go(method: string, req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return dispatch(method, req, path);
}

export function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return go("GET", req, ctx);
}

export function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return go("POST", req, ctx);
}
