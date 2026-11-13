// Sentences and citations captured with a step. The citation is the element's own string.

import type { AnchorLocator, CitationSource, Identity, StepCaption, TargetBox } from "./schema";
import { fileName, fileOperands } from "./file-operands";
import { tabCommandAction, type TabCommandAction } from "./tab-command";

type LocatorRelation = AnchorLocator["relation"];

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
  const fields = {
    text: extra?.text ?? node?.text,
    name: extra?.name ?? node?.name,
    label: extra?.label ?? node?.label,
    ariaLabel: extra?.ariaLabel ?? node?.ariaLabel,
    placeholder: extra?.placeholder ?? node?.placeholder,
    alt: extra?.alt,
    title: extra?.title ?? node?.title,
  };
  if (node?.nameSource === "aria-label") {
    fields.ariaLabel = node.ariaLabel || node.name;
    fields.name = undefined;
    fields.label = undefined;
  } else if (node?.nameSource === "title") {
    fields.title = node.title || node.name;
    fields.name = undefined;
    fields.label = undefined;
  } else if (node?.nameSource === "label") {
    fields.label = node.label || node.name;
    fields.name = undefined;
  } else if (node?.nameSource === "placeholder") {
    fields.placeholder = node.placeholder || node.name;
    fields.name = undefined;
    fields.label = undefined;
  }
  if (node?.role === "listbox") fields.text = undefined;
  const form = node?.role === "textbox" || node?.role === "searchbox" || node?.role === "combobox" || node?.role === "listbox" || node?.role === "spinbutton";
  if (!form) return cite(fields);
  return cite({
    label: fields.label,
    name: fields.name,
    ariaLabel: fields.ariaLabel,
    placeholder: fields.placeholder,
    title: fields.title,
    alt: fields.alt,
    text: fields.text,
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

const CONTROL_WORDS: Record<string, string> = {
  button: "button",
  link: "link",
  checkbox: "checkbox",
  radio: "radio button",
  radiobutton: "radio button",
  switch: "switch",
  tab: "tab",
  menuitem: "menu item",
  option: "option",
  combobox: "menu",
  popupbutton: "menu",
  textbox: "box",
  textfield: "box",
  searchbox: "search box",
  img: "image",
  image: "image",
  row: "row",
  cell: "cell",
};

const NEAR_WORDS: Record<LocatorRelation, string> = { right: "after", left: "before", below: "below", above: "above" };

export function controlWord(role: string | undefined): string {
  const key = (role || "").toLowerCase().replace(/^ax/, "");
  return CONTROL_WORDS[key] || "control";
}

/** A click names the control. An unnamed one reads as its role, placed by a nearby string when one is known. */
export function clickSentence(name: string | undefined, role?: string, near?: { relation: LocatorRelation; text?: string }): string {
  const shown = name?.replace(/\s+/g, " ").trim();
  if (shown) return `Click ${shown}`;
  const what = `the ${controlWord(role)}`;
  const anchor = near?.text?.replace(/\s+/g, " ").trim();
  return anchor && near ? `Click ${what} ${NEAR_WORDS[near.relation]} "${anchor}"` : `Click ${what}`;
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

const TAB_SENTENCES: Record<TabCommandAction, string> = {
  list: "Listed tabs",
  new: "Opened a new tab",
  close: "Closed a tab",
  switch: "Switched tab",
};

export function tabSentence(args: readonly string[] | string | undefined): string {
  return TAB_SENTENCES[tabCommandAction(typeof args === "string" ? [args] : args)];
}

/** Sentence for a pass-through command. The name comes from the snapshot line for that ref. */
export function commandSentence(command: string, arg: string | readonly string[] | undefined, snapshot: string | undefined): { text: string; citation?: { text: string; source: "text" } } {
  const head = typeof arg === "string" ? arg : arg?.[0];
  if (command === "open") return { text: openSentence(head) };
  if (command === "wait_for_owner") return { text: "Wait for you to sign in" };
  if (command === "snapshot") return { text: "Read the page" };
  if (command === "press") return { text: `Press ${head && !isElementRef(head) ? head : "key"}` };
  if (command === "close") return { text: "Close the page" };
  if (command === "scroll") return { text: "Scroll the page" };
  if (command === "screenshot") return { text: "Capture the page" };
  if (command === "tab") return { text: tabSentence(arg) };
  if (command === "upload" || command === "download") {
    const files = fileOperands(typeof arg === "string" ? [arg] : arg ?? []).files.map(fileName).join(", ");
    const verb = command === "upload" ? "Upload" : "Download";
    return { text: files ? `${verb} ${files}` : `${verb} a file` };
  }
  const line = refLine(head, snapshot);
  const named = refName(line);
  if (command === "fill") return named
    ? { text: `Type into ${named}`, citation: { text: named, source: "text" } }
    : { text: "Type" };
  if (command === "click") return named
    ? { text: `Click ${named}`, citation: { text: named, source: "text" } }
    : { text: clickSentence(undefined, line?.match(/^\s*-\s*([A-Za-z]+)/)?.[1]) };
  return { text: command };
}

function refLine(arg: string | undefined, snapshot: string | undefined): string | undefined {
  const ref = arg?.trim();
  if (!ref || !snapshot || !isElementRef(ref)) return undefined;
  const needle = `ref=${ref.slice(1)}`;
  return snapshot.split("\n").find((row) => {
    const at = row.indexOf(needle);
    if (at < 0) return false;
    const after = row[at + needle.length];
    return !after || !/\d/.test(after);
  });
}

function refName(line: string | undefined): string | undefined {
  const quoted = line?.match(/"([^\"]+)"/)?.[1]?.trim();
  if (!quoted || isElementRef(quoted) || quoted.startsWith("@e")) return undefined;
  return quoted;
}
