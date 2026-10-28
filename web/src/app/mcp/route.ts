import { registryRelay } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export function GET(req: Request) {
  return registryRelay().handle(req, null);
}

export function DELETE(req: Request) {
  return registryRelay().handle(req, null);
}

export function POST(req: Request) {
  return registryRelay().handle(req, null);
}
