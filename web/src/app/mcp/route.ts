import { handleMcp } from "@/lib/agent";
import { remoteDisabled, remoteMcpEnabled } from "@/lib/remote-flag";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export function GET() {
  if (!remoteMcpEnabled()) return remoteDisabled();
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { allow: "POST", "content-type": "application/json" },
  });
}

export function DELETE() {
  if (!remoteMcpEnabled()) return remoteDisabled();
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export function POST(req: Request) {
  if (!remoteMcpEnabled()) return remoteDisabled();
  return handleMcp(req);
}
