// Relative dates. No Node builtins: the desktop window bundles this for the run form.

export interface Civil {
  y: number;
  m: number;
  d: number;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function defaultZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function zoneOk(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function civilInZone(now: Date, zone: string): Civil {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const num = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { y: num("year"), m: num("month"), d: num("day") };
}

export function addDays(date: Civil, days: number): Civil {
  const utc = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: utc.getUTCFullYear(), m: utc.getUTCMonth() + 1, d: utc.getUTCDate() };
}

export function diffDays(from: Civil, to: Civil): number {
  const a = Date.UTC(from.y, from.m - 1, from.d);
  const b = Date.UTC(to.y, to.m - 1, to.d);
  return Math.round((b - a) / 86_400_000);
}

export function isoOf(date: Civil): string {
  return formatCivil(date, "YYYY-MM-DD");
}

export function formatCivil(date: Civil, format: string): string {
  const tokens: [string, string][] = [
    ["YYYY", String(date.y).padStart(4, "0")],
    ["YY", String(date.y).slice(-2)],
    ["MMMM", MONTHS[date.m - 1] || ""],
    ["MMM", MONTHS_SHORT[date.m - 1] || ""],
    ["MM", String(date.m).padStart(2, "0")],
    ["DD", String(date.d).padStart(2, "0")],
    ["D", String(date.d)],
    ["M", String(date.m)],
  ];
  let out = "";
  for (let i = 0; i < format.length;) {
    const hit = tokens.find(([token]) => format.startsWith(token, i));
    if (hit) {
      out += hit[1];
      i += hit[0].length;
    } else {
      out += format[i];
      i += 1;
    }
  }
  return out;
}

function nextWeekday(today: Civil, weekday: number): Civil {
  const utc = new Date(Date.UTC(today.y, today.m - 1, today.d));
  const current = utc.getUTCDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(today, delta);
}

function firstOfNextMonth(today: Civil): Civil {
  if (today.m === 12) return { y: today.y + 1, m: 1, d: 1 };
  return { y: today.y, m: today.m + 1, d: 1 };
}

/** today, +14d, -2d, next monday, first of next month, or an ISO date. */
export function resolveRelative(expr: string, today: Civil): Civil {
  const text = expr.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text || text === "today") return today;
  const offset = text.match(/^([+-]?\d+)d$/);
  if (offset) return addDays(today, Number(offset[1]));
  const next = text.match(/^next (sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (next) return nextWeekday(today, WEEKDAYS.indexOf(next[1]!));
  if (text === "first of next month") return firstOfNextMonth(today);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  throw new Error(`bad date: ${expr}`);
}

export function relativeBetween(today: Civil, picked: Civil): string {
  const n = diffDays(today, picked);
  if (n === 0) return "today";
  return n > 0 ? `+${n}d` : `${n}d`;
}

export function parseRecordedDate(value: string): { civil: Civil; format: string } | undefined {
  const v = value.trim();
  let match = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const civil = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
    if (!validCivil(civil)) return undefined;
    return { civil, format: "YYYY-MM-DD" };
  }
  match = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    const y = Number(match[3]);
    let day: number;
    let month: number;
    let format: string;
    if (a > 12) {
      day = a;
      month = b;
      format = a > 9 ? "DD/MM/YYYY" : "D/MM/YYYY";
    } else if (b > 12) {
      month = a;
      day = b;
      format = a > 9 ? "MM/DD/YYYY" : "M/DD/YYYY";
    } else {
      day = a;
      month = b;
      format = "DD/MM/YYYY";
    }
    const civil = { y, m: month, d: day };
    if (!validCivil(civil)) return undefined;
    return { civil, format };
  }
  match = v.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (match) {
    const month = monthIndex(match[2]!);
    if (!month) return undefined;
    const civil = { y: Number(match[3]), m: month, d: Number(match[1]) };
    if (!validCivil(civil)) return undefined;
    const format = match[2]!.length > 3 ? "D MMMM YYYY" : "D MMM YYYY";
    return { civil, format };
  }
  match = v.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (match) {
    const month = monthIndex(match[1]!);
    if (!month) return undefined;
    const civil = { y: Number(match[3]), m: month, d: Number(match[2]) };
    if (!validCivil(civil)) return undefined;
    const format = match[1]!.length > 3 ? "MMMM D, YYYY" : "MMM D, YYYY";
    return { civil, format };
  }
  return undefined;
}

function monthIndex(name: string): number {
  const lower = name.toLowerCase();
  const long = MONTHS.findIndex((month) => month.toLowerCase() === lower);
  if (long >= 0) return long + 1;
  const short = MONTHS_SHORT.findIndex((month) => month.toLowerCase() === lower);
  return short >= 0 ? short + 1 : 0;
}

function validCivil(date: Civil): boolean {
  if (date.m < 1 || date.m > 12 || date.d < 1 || date.d > 31 || date.y < 1) return false;
  const check = new Date(Date.UTC(date.y, date.m - 1, date.d));
  return check.getUTCFullYear() === date.y && check.getUTCMonth() === date.m - 1 && check.getUTCDate() === date.d;
}

export function datePreview(expr: string, format: string, zone: string, now: Date): string {
  const civil = resolveRelative(expr, civilInZone(now, zone));
  return formatCivil(civil, format || "YYYY-MM-DD");
}

export function looksLikeDateField(identity?: { id?: string; nameAttr?: string; label?: string; name?: string; text?: string }): boolean {
  if (!identity) return false;
  const hay = [identity.id, identity.nameAttr, identity.label, identity.name, identity.text].filter(Boolean).join(" ");
  return /\b(date|check-?in|check-?out|dob|birthday|arrival|departure)\b/i.test(hay);
}
