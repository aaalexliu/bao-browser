// Sentences and citations captured with a step. The citation is the element's own string.

import type { CitationSource, Identity, StepCaption, TargetBox } from "./schema";

export interface CiteFields {
  text?: string;
  name?: string;
  label?: string;
  ariaLabel?: string;
  placeholder?: string;
  alt?: string;
  title?: string;
}

export function cite(fields: CiteFields): StepCaption["citation"] | undefined {
  const pick = (value: string | undefined, source: CitationSource) => {
    const text = value?.replace(/\s+/g, " ").trim();
    return text ? { text, source } : undefined;
  };
  return pick(fields.text, "text")
    || pick(fields.name, "name")
    || pick(fields.label, "label")
    || pick(fields.ariaLabel, "aria-label")
    || pick(fields.placeholder, "placeholder")
    || pick(fields.alt, "alt")
    || pick(fields.title, "title");
}

export function citeIdentity(node: Identity | undefined, extra?: CiteFields): StepCaption["citation"] | undefined {
  if (!node && !extra) return undefined;
  return cite({
    text: extra?.text ?? node?.text,
    name: extra?.name ?? node?.name,
    label: extra?.label ?? node?.label,
    ariaLabel: extra?.ariaLabel,
    placeholder: extra?.placeholder ?? node?.placeholder,
    alt: extra?.alt,
    title: extra?.title ?? node?.title,
  });
}

export function targetBox(rect: { x: number; y: number; width?: number; height?: number; w?: number; h?: number } | undefined, viewport: { width: number; height: number } | undefined): TargetBox | undefined {
  if (!rect || !viewport || viewport.width <= 0 || viewport.height <= 0) return undefined;
  const width = rect.width ?? rect.w;
  const height = rect.height ?? rect.h;
  if (width == null || height == null) return undefined;
  if (![rect.x, rect.y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  const right = rect.x + width;
  const bottom = rect.y + height;
  if (right <= 0 || bottom <= 0 || rect.x >= viewport.width || rect.y >= viewport.height) return undefined;
  return { x: rect.x, y: rect.y, width, height, viewport: { width: viewport.width, height: viewport.height } };
}

export function caption(text: string, citation?: StepCaption["citation"], box?: TargetBox): StepCaption {
  const sentence = text.replace(/\s+/g, " ").trim() || "Step";
  return {
    text: sentence,
    ...(citation ? { citation } : {}),
    ...(box ? { targetBox: box } : {}),
  };
}

export function clickSentence(name: string | undefined): string {
  const shown = name?.replace(/\s+/g, " ").trim();
  return shown ? `Click ${shown}` : "Click";
}

export function typeSentence(field: string | undefined, secret = false): string {
  if (secret) return "Type the password";
  const shown = field?.replace(/\s+/g, " ").trim();
  return shown ? `Type into ${shown}` : "Type";
}

export function openSentence(url: string | undefined): string {
  if (!url) return "Open the page";
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `Open ${parsed.host}${path}`;
  } catch {
    return `Open ${url}`;
  }
}

/** Never keep an agent-browser ref as a sentence or a citation. */
export function isElementRef(value: string | undefined): boolean {
  return !!value && /^@e\d+$/.test(value.trim());
}

/** Sentence for a pass-through command. The name comes from the snapshot line for that ref. */
export function commandSentence(command: string, arg: string | undefined, snapshot: string | undefined): { text: string; citation?: { text: string; source: "text" } } {
  if (command === "open") return { text: openSentence(arg) };
  if (command === "wait_for_owner") return { text: "Wait for you to sign in" };
  if (command === "snapshot") return { text: "Read the page" };
  if (command === "press") return { text: `Press ${arg && !isElementRef(arg) ? arg : "key"}` };
  if (command === "close") return { text: "Close the page" };
  if (command === "scroll") return { text: "Scroll the page" };
  if (command === "screenshot") return { text: "Capture the page" };
  if (command === "tab") return { text: "Switch tab" };
  const named = refName(arg, snapshot);
  if (command === "fill") return named
    ? { text: `Type into ${named}`, citation: { text: named, source: "text" } }
    : { text: "Type" };
  if (command === "click") return named
    ? { text: `Click ${named}`, citation: { text: named, source: "text" } }
    : { text: "Click" };
  return { text: command };
}

function refName(arg: string | undefined, snapshot: string | undefined): string | undefined {
  if (!arg || !snapshot) return undefined;
  const ref = arg.replace(/^@/, "");
  const line = snapshot.split("\n").find((row) => new RegExp(`\\bref=${ref}\\b`).test(row));
  const quoted = line?.match(/"([^\"]+)"/)?.[1]?.trim();
  if (!quoted || isElementRef(quoted) || quoted.startsWith("@e")) return undefined;
  return quoted;
}
