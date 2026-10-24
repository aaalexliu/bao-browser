/** Turn a capture field into a URL the owned browser can open.
 * A path stays on this app. The product window shows the path, not the listen address. */
export function resolveCaptureUrl(value: string | undefined, port: number): string {
  const raw = (value || "").trim();
  if (!raw) return `http://127.0.0.1:${port}/fixture`;
  if (raw.startsWith("/") && !raw.startsWith("//")) return `http://127.0.0.1:${port}${raw}`;
  return raw;
}
