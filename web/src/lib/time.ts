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

/** Hour and zone only, in the viewer's zone. `2:00 AM EDT`, never a fixed UTC clock. */
export function formatTime(at: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(at)).replace(/\u202f/g, " ");
}

/**
 * A recent backup. The phrase is the viewer's night or day, then the zoned clock:
 * `Last night, 2:00 AM EDT`. An older instant stays the full calendar clock.
 */
export function formatFriendly(at: number, now = Date.now()): string {
  const phrase = friendlyDay(at, now);
  return phrase ? `${phrase}, ${formatTime(at)}` : formatClock(at);
}

interface LocalStamp {
  key: number;
  hour: number;
}

function localStamp(at: number): LocalStamp {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const bag: Record<string, string> = {};
  for (const part of parts) bag[part.type] = part.value;
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  const year = Number(bag.year);
  const month = Number(bag.month);
  const day = Number(bag.day);
  return { key: year * 10000 + month * 100 + day, hour };
}

function shiftKey(key: number, days: number): number {
  const year = Math.floor(key / 10000);
  const month = Math.floor((key % 10000) / 100);
  const day = key % 100;
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return moved.getUTCFullYear() * 10000 + (moved.getUTCMonth() + 1) * 100 + moved.getUTCDate();
}

/** Last night is 9:00 PM yesterday through 5:00 AM today, in the viewer's zone. */
function friendlyDay(at: number, now: number): string | undefined {
  if (at > now) return undefined;
  const when = localStamp(at);
  const today = localStamp(now);
  const yesterday = shiftKey(today.key, -1);
  const lastNight = (when.key === yesterday && when.hour >= 21) || (when.key === today.key && when.hour < 5);
  if (lastNight) return "Last night";
  if (when.key === today.key) {
    if (when.hour < 12) return "This morning";
    if (when.hour < 17) return "This afternoon";
    if (when.hour < 21) return "This evening";
    return "Tonight";
  }
  if (when.key === yesterday) return "Yesterday";
  return undefined;
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
