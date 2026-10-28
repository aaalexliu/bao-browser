// Remote MCP is off unless the registry process is started with BAO_REMOTE_MCP=1.
// The desktop dials the relay only after this Mac opts in and relay.json is present.

export function remoteMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BAO_REMOTE_MCP === "1";
}

export function remoteDisabled(): Response {
  return new Response(JSON.stringify({ error: "remote_disabled" }), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
