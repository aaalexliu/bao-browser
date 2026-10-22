import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { actor, answersFrom, fail, formPost, readBody, requireUser, session } from "./http";
import { plainReplayReason } from "./review-gate";
import {
  activePairCode,
  catalog,
  categoryCounts,
  claimPairCode,
  confirmPublish,
  createShare,
  forkPublic,
  getShare,
  githubStub,
  installShare,
  issuePairCode,
  listDevices,
  listLibrary,
  listRuns,
  listVersions,
  logout,
  marketplace,
  previewPublication,
  publicWorkflow,
  pull,
  pushRun,
  pushVersion,
  readBlob,
  recordReview,
  rememberGrant,
  reportWorkflow,
  requestMagicLink,
  saveAccountSettings,
  setImportMarks,
  syncSnapshot,
  userFromSession,
  verifyMagicLink,
} from "./registry";

export async function dispatch(method: string, req: Request, parts: string[]): Promise<Response> {
  try {
    const url = new URL(req.url);
    if (method === "GET" && parts[0] === "health") {
      await actor(req);
      return NextResponse.json({ ok: true, driver: process.env.DATABASE_URL ? "postgres" : "pglite" });
    }
    if (method === "POST" && parts[0] === "auth" && parts[1] === "magic") {
      await actor(req);
      const body = await readBody(req);
      const result = await requestMagicLink(String(body.email || ""));
      return NextResponse.json({ ok: true, ...result });
    }
    if (method === "GET" && parts[0] === "auth" && parts[1] === "verify") {
      await actor(req);
      const verified = await verifyMagicLink(url.searchParams.get("token") || "");
      return session(NextResponse.redirect(new URL("/", req.url)), verified.session);
    }
    if (method === "GET" && parts[0] === "auth" && parts[1] === "github") {
      await actor(req);
      const stub = await githubStub();
      return session(NextResponse.redirect(new URL("/", req.url)), stub.session);
    }
    if (method === "POST" && parts[0] === "auth" && parts[1] === "logout") {
      const jar = await cookies();
      await logout(jar.get("bao_session")?.value);
      const res = NextResponse.redirect(new URL("/login", req.url));
      res.cookies.set("bao_session", "", { path: "/", maxAge: 0 });
      return res;
    }
    if (parts[0] === "pair" && parts.length === 1 && method === "POST") {
      const principal = await requireUser(req);
      const created = await issuePairCode(principal.userId);
      return finish(req, created, "/pair");
    }
    if (parts[0] === "pair" && parts[1] === "claim" && method === "POST") {
      await actor(req);
      const body = await readBody(req);
      return NextResponse.json(await claimPairCode(String(body.code || ""), String(body.name || "device")));
    }
    if (parts[0] === "devices" && method === "GET") {
      const principal = await requireUser(req);
      const [devices, categories] = await Promise.all([
        listDevices(principal.userId),
        categoryCounts(principal.userId),
      ]);
      return NextResponse.json({ devices, categories });
    }
    if (parts[0] === "sync" && parts[1] === "snapshot" && method === "GET") {
      const principal = await requireUser(req);
      return NextResponse.json(await syncSnapshot(principal));
    }
    if (parts[0] === "sync" && parts[1] === "settings" && method === "POST") {
      const principal = await requireUser(req);
      return NextResponse.json(await saveAccountSettings(principal, await readBody(req)));
    }
    if (parts[0] === "catalog" && method === "GET") {
      const principal = await actor(req);
      const hits = await catalog(principal, url.searchParams.get("q") || "", {
        source: url.searchParams.get("source") || undefined,
        site: url.searchParams.get("site") || undefined,
        category: url.searchParams.get("category") || undefined,
      });
      return NextResponse.json({ hits });
    }
    if (parts[0] === "marketplace" && parts.length === 1 && method === "GET") {
      await actor(req);
      const hits = await marketplace(
        url.searchParams.get("q") || "",
        url.searchParams.get("site") || "",
        url.searchParams.get("category") || "",
      );
      return NextResponse.json({ hits });
    }
    if (parts[0] === "marketplace" && parts[2] === "fork" && method === "POST") {
      const principal = await requireUser(req);
      const body = await readBody(req);
      const created = await forkPublic(principal, parts[1] || "", answersFrom(body));
      return finish(req, created, `/workflows/${created.id}`);
    }
    if (parts[0] === "marketplace" && parts[2] === "report" && method === "POST") {
      const principal = await requireUser(req);
      const body = await readBody(req);
      await reportWorkflow(principal, parts[1] || "", String(body.reason || ""));
      return finish(req, { ok: true }, `/marketplace/${parts[1]}?reported=1`);
    }
    if (parts[0] === "marketplace" && parts[1] && method === "GET") {
      await actor(req);
      return NextResponse.json(await publicWorkflow(parts[1]));
    }
    if (parts[0] === "workflows" && method === "GET" && parts.length === 1) {
      const principal = await requireUser(req);
      const workflows = await listLibrary(principal.userId, url.searchParams.get("q") || "");
      return NextResponse.json({ workflows });
    }
    if (parts[0] === "workflows" && parts[2] === "versions" && method === "GET") {
      const principal = await requireUser(req);
      return NextResponse.json({ versions: await listVersions(principal, parts[1] || "") });
    }
    if (parts[0] === "workflows" && parts[2] === "versions" && method === "POST") {
      const principal = await requireUser(req);
      const body = await readBody(req);
      const result = await pushVersion(principal, parts[1] || "", body);
      return NextResponse.json(result, { status: 201 });
    }
    if (parts[0] === "workflows" && parts[2] === "runs" && method === "GET") {
      const principal = await requireUser(req);
      return NextResponse.json({ runs: await listRuns(principal, parts[1] || "") });
    }
    if (parts[0] === "workflows" && parts[2] === "runs" && method === "POST") {
      const principal = await requireUser(req);
      const body = await readBody(req);
      return NextResponse.json(await pushRun(principal, parts[1] || "", body), { status: 201 });
    }
    if (parts[0] === "workflows" && parts[2] === "share" && method === "POST") {
      const principal = await requireUser(req);
      const body = await readBody(req);
      const share = await createShare(principal, parts[1] || "", String(body.permission || "view"));
      return finish(req, share, `/workflows/${parts[1]}?share=${share.token}&permission=${share.permission}`);
    }
    if (parts[0] === "workflows" && parts[2] === "review" && method === "POST") {
      const principal = await requireUser(req);
      const body = await readBody(req);
      const shots = Array.isArray(body.shots) ? body.shots as { stepId?: string; png?: string; redacted?: boolean }[] : [];
      const samples = body.samples && typeof body.samples === "object" && !Array.isArray(body.samples)
        ? body.samples as Record<string, unknown>
        : {};
      return NextResponse.json(await recordReview(principal, parts[1] || "", String(body.documentHash || ""), shots, samples));
    }
    if (parts[0] === "workflows" && parts[2] === "inputs" && method === "POST") {
      const principal = await requireUser(req);
      const body = await readBody(req);
      const names = Object.keys(body).filter((key) => key.startsWith("ask_") && body[key]).map((key) => key.slice(4));
      const result = await setImportMarks(principal, parts[1] || "", names);
      return finish(req, result, `/workflows/${parts[1]}`);
    }
    if (parts[0] === "workflows" && parts[2] === "publish" && method === "GET") {
      const principal = await requireUser(req);
      const preview = await previewPublication(principal, parts[1] || "");
      const why = !preview.reviewed
        ? "Replay on a device before listing."
        : preview.gateStep
          ? (plainReplayReason(String(preview.gateReason || "")) || "The clean replay did not pass.")
          : "";
      return NextResponse.json({
        enabled: preview.reviewed && !preview.gateStep,
        why,
        link: preview.link,
        importLink: preview.importLink,
      });
    }
    if (parts[0] === "workflows" && parts[2] === "publish" && method === "POST") {
      const principal = await requireUser(req);
      const result = await confirmPublish(principal, parts[1] || "");
      return finish(req, result, `/marketplace/${parts[1]}`);
    }
    if (parts[0] === "workflows" && parts[1] && method === "GET") {
      const principal = await requireUser(req);
      const version = url.searchParams.get("v");
      return NextResponse.json(await pull(principal, parts[1], version ? Number(version) : undefined));
    }
    if (parts[0] === "share" && parts[2] === "install" && method === "POST") {
      const principal = await requireUser(req);
      const body = await readBody(req);
      const created = await installShare(principal, parts[1] || "", answersFrom(body));
      return finish(req, created, `/workflows/${created.id}`);
    }
    if (parts[0] === "share" && parts[1] && method === "GET") {
      const principal = await actor(req);
      const share = principal ? await rememberGrant(principal.userId, parts[1]) : await getShare(parts[1]);
      return NextResponse.json(share);
    }
    if (parts[0] === "blobs" && method === "GET") {
      const principal = await actor(req);
      const key = parts.slice(1).join("/");
      const bytes = await readBlob(principal, key, url.searchParams.get("share"));
      return new NextResponse(new Uint8Array(bytes), {
        headers: { "content-type": "image/png", "cache-control": "private, no-store" },
      });
    }
    if (parts[0] === "me" && method === "GET") {
      await actor(req);
      const jar = await cookies();
      const user = await userFromSession(jar.get("bao_session")?.value);
      const code = user ? await activePairCode(user.id) : null;
      return NextResponse.json({ user, pair: code });
    }
    return NextResponse.json({ error: "not found" }, { status: 404 });
  } catch (err) {
    return fail(err);
  }
}

function finish(req: Request, body: unknown, location: string) {
  if (formPost(req)) return NextResponse.redirect(new URL(location, req.url));
  return NextResponse.json(body);
}
