// Category label sent with a workflow. Host rules match the registry.

export function domainsOf(document: unknown): string[] {
  const hosts = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return;
    try {
      const host = new URL(value).hostname;
      if (host) hosts.add(host);
    } catch {
      /* not a url */
    }
  };
  const doc = document as { startUrl?: string; steps?: { value?: string; postcondition?: { match?: string } }[] };
  add(doc?.startUrl);
  for (const step of doc?.steps ?? []) {
    add(step.value);
    add(step.postcondition?.match);
  }
  return [...hosts];
}

export function categoryFor(document: unknown, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const host = domainsOf(document)[0] || "";
  if (host.includes("wikipedia")) return "Research";
  if (host.includes("mozilla")) return "Reference";
  if (host.includes("httpbin")) return "Forms";
  if (host === "127.0.0.1" || host === "localhost") return "Fixture";
  return "General";
}
