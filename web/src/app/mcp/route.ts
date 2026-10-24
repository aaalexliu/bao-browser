import { handleMcp } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export function GET() {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { allow: "POST", "content-type": "application/json" },
  });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export function POST(req: Request) {
  return handleMcp(req);
}
