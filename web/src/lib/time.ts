// One clock for the desktop window and the web app. The label is the machine
// zone, and the short zone name is part of the text, so a UTC clock and an
// Eastern clock are not written the same way. A recent instant also says how
// long ago.

export function formatClock(at: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(at)).replace(/\u202f/g, " ");
}

export function formatRelative(at: number, now = Date.now()): string {
  const min = Math.round((now - at) / 60000);
  if (!Number.isFinite(min) || min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** The zoned clock. The last day leads with how long ago, where a row has room. */
export function formatWhen(at: number, now = Date.now()): string {
  const clock = formatClock(at);
  const age = now - at;
  if (Number.isFinite(age) && age >= 0 && age < 24 * 60 * 60 * 1000) {
    return `${formatRelative(at, now)} · ${clock}`;
  }
  return clock;
}

export function formatStored(value: unknown, now = Date.now()): string {
  if (value == null || value === "") return "";
  const date = value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value));
  if (Number.isNaN(date.getTime())) return "";
  return formatWhen(date.getTime(), now);
}

/** Web pages. An empty or unreadable value stays the empty-state sentence. */
export function when(value: unknown, now = Date.now()): string {
  return formatStored(value, now) || "Not replayed yet";
}
