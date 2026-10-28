import { liveShotUrl, type LiveSessionRecord } from "../cdp-live/live-record";

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
}

function trustedWord(value: boolean | null, via: string): string {
  if (via === "ax") return "AX press";
  if (value === true) return "trusted";
  if (value === false) return "untrusted";
  return "—";
}

/** `?screen=live` opens the run view. Any other value stays on the library. */
export function screenFromQuery(search: string): "live" | "" {
  return new URLSearchParams(search).get("screen") === "live" ? "live" : "";
}

/** Local run view. Shot URLs point at this machine's app, never at a remote host. */
export function liveSessionView(session: LiveSessionRecord | null | undefined): string {
  if (!session || session.status === "idle") {
    return `<section id="live-session" data-status="idle"><h2>Live session</h2><p class="quiet">No live session yet. A run on this Mac shows its steps, audit, and blurred page shots here.</p></section>`;
  }
  const steps = session.steps.map((step) =>
    `<li data-status="${esc(step.status)}"><strong>${esc(step.name)}</strong> <span class="quiet">${esc(step.status)} · ${step.ms} ms</span></li>`).join("");
  const rows = session.audit.map((row) =>
    `<tr><td>${esc(row.action)}</td><td>${esc(row.label)}</td><td class="mono">${esc(row.path)}</td><td>${esc(trustedWord(row.isTrusted, row.via))}</td><td>${row.ms} ms</td></tr>`).join("");
  const shots = session.audit.filter((row) => row.shot).map((row) => {
    const src = liveShotUrl(row.shot);
    if (!src) return "";
    return `<figure><img alt="${esc(`${row.action} ${row.path}`)}" src="${esc(src)}"><figcaption class="quiet">${esc(row.action)} ${esc(row.path)}</figcaption></figure>`;
  }).join("");
  return `<section id="live-session" data-status="${esc(session.status)}">
    <h2>Live session</h2>
    <p id="live-status"><strong>${esc(session.status)}</strong> ${esc(session.host)}</p>
    <p class="quiet">${esc(session.intent)}</p>
    ${session.note ? `<p class="quiet" id="live-note">${esc(session.note)}</p>` : ""}
    <p class="quiet">These pictures stay on this Mac. Page text is blurred before the file is written, and the app does not upload them.</p>
    <h3 class="section">Steps</h3>
    <ol id="live-steps">${steps || `<li class="quiet">No steps yet.</li>`}</ol>
    <h3 class="section">Audit</h3>
    <table id="live-audit">
      <thead><tr><th>Action</th><th>Target</th><th>Path</th><th>Trusted</th><th>Time</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h3 class="section">Shots</h3>
    <div id="live-shots">${shots || `<p class="quiet">No shots yet.</p>`}</div>
  </section>`;
}
