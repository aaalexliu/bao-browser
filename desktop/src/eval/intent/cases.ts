// Ground-truth trails. Noise is added later and is not labeled on the events
// the condenser sees.

import type { TrailEvent } from "../../v1/interpret";
import type { Identity } from "../../v1/schema";

export interface HumanMark {
  id: string;
  gate: "login" | "confirm";
  target: string;
}

export interface IntentCase {
  id: string;
  name: string;
  startUrl: string;
  events: TrailEvent[];
  secrets: string[];
  secretIds: string[];
  human: HumanMark[];
  nodes: Identity[];
  /** New values for the two replays, in text-input order. */
  replays: { texts: string[]; secret: string; file: string }[];
  /** long replaces the short coupon detour with an abort longer than the task. */
  noise?: "long";
  oracle(world: World, spec: { texts: string[]; secret: string; file: string }): string | null;
}

export interface World {
  url: string;
  texts: string[];
  values: Record<string, string>;
}

let clock = 0;

function dom(id: string, role: string, name?: string): Identity {
  return {
    surface: "dom",
    role,
    id,
    testId: id,
    name,
    text: role === "button" || role === "tab" ? name : undefined,
    nameAttr: role === "textbox" ? id : undefined,
    path: [],
  };
}

function click(id: string, name: string, role: string, extra: Partial<TrailEvent> = {}): TrailEvent {
  clock += 1;
  return {
    id,
    ts: clock,
    kind: "act",
    op: "click",
    identity: dom(id, role, name),
    ...extra,
  };
}

function type(id: string, value: string, extra: Partial<TrailEvent> = {}): TrailEvent {
  clock += 1;
  return {
    id,
    ts: clock,
    kind: "act",
    op: "type",
    value,
    identity: dom(id, "textbox", id),
    ...extra,
  };
}

function key(id: string, name: string, afterText?: string): TrailEvent {
  clock += 1;
  return {
    id,
    ts: clock,
    kind: "act",
    op: "key",
    key: name,
    afterText,
  };
}

function file(id: string, op: "upload" | "drop", fileName: string): TrailEvent {
  clock += 1;
  return {
    id,
    ts: clock,
    kind: "act",
    op,
    fileName,
    identity: dom(id, "textbox", id),
    afterText: "Uploaded",
  };
}

function nodesOf(events: TrailEvent[]): Identity[] {
  const out: Identity[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const id = event.identity?.id;
    if (!event.identity || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(event.identity);
  }
  for (const extra of NOISE_NODES) {
    if (!seen.has(extra.id || "")) out.push(extra);
  }
  return out;
}

export const NOISE_NODES: Identity[] = [
  dom("help", "button", "Help"),
  dom("coupon", "button", "Coupon"),
  dom("cancel", "button", "Cancel"),
  dom("couponcode", "textbox", "Code"),
];

function make(
  partial: Omit<IntentCase, "nodes"> & { events: TrailEvent[] },
): IntentCase {
  return { ...partial, nodes: nodesOf(partial.events) };
}

function has(world: World, text: string): boolean {
  return world.texts.some((item) => item.includes(text));
}

export const INTENT_CASES: IntentCase[] = [
  make({
    id: "save-name",
    name: "Save a name",
    startUrl: "https://fixture.test/save-name",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      type("name", "Ada"),
      click("save", "Save", "button", { afterText: "Saved" }),
    ],
    replays: [
      { texts: ["Grace"], secret: "", file: "a.txt" },
      { texts: ["Lin"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.name === spec.texts[0] && has(world, "Saved") ? null : "save-name",
  }),
  make({
    id: "email-note",
    name: "Email a note",
    startUrl: "https://fixture.test/email-note",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      type("who", "ada@example.com"),
      type("note", "hello"),
      click("send", "Send", "button", { afterText: "Sent" }),
    ],
    replays: [
      { texts: ["g@example.com", "bye"], secret: "", file: "a.txt" },
      { texts: ["l@example.com", "later"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.who === spec.texts[0] && world.values.note === spec.texts[1] && has(world, "Sent") ? null : "email-note",
  }),
  make({
    id: "login",
    name: "Log in",
    startUrl: "https://fixture.test/login",
    secrets: ["SuperSecretPassword!"],
    secretIds: ["login-password"],
    human: [
      { id: "login-password", gate: "login", target: "password" },
      { id: "login-btn", gate: "login", target: "login-btn" },
    ],
    events: [
      type("username", "ada"),
      type("password", "SuperSecretPassword!", { id: "login-password", sensitive: true, gate: "login" }),
      click("login-btn", "Log in", "button", {
        gate: "login",
        beforeUrl: "https://fixture.test/login",
        afterUrl: "https://fixture.test/secure",
      }),
    ],
    replays: [
      { texts: ["grace"], secret: "replay-secret-one", file: "a.txt" },
      { texts: ["lin"], secret: "replay-secret-two", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.username === spec.texts[0]
      && world.values.password === spec.secret
      && world.url.includes("/secure")
      && has(world, "Welcome " + spec.texts[0]) ? null : "login",
  }),
  make({
    id: "confirm-delete",
    name: "Confirm delete",
    startUrl: "https://fixture.test/confirm-delete",
    secrets: [],
    secretIds: [],
    human: [{ id: "confirm", gate: "confirm", target: "confirm" }],
    events: [
      type("reason", "old"),
      click("delete", "Delete", "button", { afterText: "Armed" }),
      click("confirm", "Confirm", "button", { gate: "confirm", afterText: "Confirmed" }),
    ],
    replays: [
      { texts: ["newer"], secret: "", file: "a.txt" },
      { texts: ["newest"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.reason === spec.texts[0] && has(world, "Confirmed") ? null : "confirm-delete",
  }),
  make({
    id: "upload-title",
    name: "Upload with a title",
    startUrl: "https://fixture.test/upload-title",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      type("title", "Taxes"),
      file("file", "upload", "taxes.pdf"),
    ],
    replays: [
      { texts: ["Notes"], secret: "", file: "notes.txt" },
      { texts: ["Pics"], secret: "", file: "pics.txt" },
    ],
    oracle: (world, spec) => world.values.title === spec.texts[0] && world.values.file === spec.file && has(world, "Uploaded") ? null : "upload-title",
  }),
  make({
    id: "terms",
    name: "Accept terms",
    startUrl: "https://fixture.test/terms",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      click("terms", "Terms", "checkbox", { checked: true }),
      click("continue", "Continue", "button", { afterText: "Continued" }),
    ],
    replays: [
      { texts: [], secret: "", file: "a.txt" },
      { texts: [], secret: "", file: "b.txt" },
    ],
    oracle: (world) => world.values.terms === "on" && has(world, "Continued") ? null : "terms",
  }),
  make({
    id: "tabs",
    name: "Address tab",
    startUrl: "https://fixture.test/tabs",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      click("tab-address", "Address", "tab"),
      type("city", "Paris"),
      click("tab-review", "Review", "tab"),
      click("finish", "Finish", "button", { afterText: "Done" }),
    ],
    replays: [
      { texts: ["Lyon"], secret: "", file: "a.txt" },
      { texts: ["Nice"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.city === spec.texts[0] && has(world, "Done") ? null : "tabs",
  }),
  make({
    id: "search",
    name: "Search",
    startUrl: "https://fixture.test/search",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      type("query", "bao"),
      key("search-enter", "Enter", "Found"),
    ],
    replays: [
      { texts: ["replay"], secret: "", file: "a.txt" },
      { texts: ["again"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.query === spec.texts[0] && has(world, "Found") ? null : "search",
  }),
  make({
    id: "scroll-row",
    name: "Pick a row",
    startUrl: "https://fixture.test/scroll-row",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      type("filter", "grace"),
      click("row-30", "Row 30", "button", { afterText: "Picked" }),
    ],
    replays: [
      { texts: ["lin"], secret: "", file: "a.txt" },
      { texts: ["ada"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.filter === spec.texts[0] && has(world, "Picked") ? null : "scroll-row",
  }),
  make({
    id: "dialog",
    name: "Open-file dialog stub",
    startUrl: "https://fixture.test/dialog",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      click("browse", "Browse", "button", { afterText: "Dialog" }),
      type("filename", "report.txt"),
      click("open", "Open", "button", { afterText: "Opened" }),
    ],
    replays: [
      { texts: ["other.txt"], secret: "", file: "a.txt" },
      { texts: ["third.txt"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.filename === spec.texts[0] && has(world, "Opened") ? null : "dialog",
  }),
  make({
    id: "pay",
    name: "Pay and confirm",
    startUrl: "https://fixture.test/pay",
    secrets: [],
    secretIds: [],
    human: [{ id: "confirm-pay", gate: "confirm", target: "confirm-pay" }],
    events: [
      type("amount", "20"),
      click("pay", "Pay", "button", { afterText: "Paying" }),
      click("confirm-pay", "Confirm", "button", { gate: "confirm", afterText: "Confirmed" }),
    ],
    replays: [
      { texts: ["45"], secret: "", file: "a.txt" },
      { texts: ["7"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.amount === spec.texts[0] && has(world, "Confirmed") ? null : "pay",
  }),
  make({
    id: "pin",
    name: "Unlock with a pin",
    startUrl: "https://fixture.test/pin",
    secrets: ["pin-9999"],
    secretIds: ["pin-type"],
    human: [{ id: "pin-type", gate: "login", target: "pin" }],
    events: [
      type("account", "1001"),
      type("pin", "pin-9999", { id: "pin-type", sensitive: true, gate: "login" }),
      click("unlock", "Unlock", "button", { afterText: "Unlocked" }),
    ],
    replays: [
      { texts: ["2002"], secret: "pin-1111", file: "a.txt" },
      { texts: ["3003"], secret: "pin-2222", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.account === spec.texts[0] && world.values.pin === spec.secret && has(world, "Unlocked") ? null : "pin",
  }),
  make({
    id: "color",
    name: "Choose a color",
    startUrl: "https://fixture.test/color",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      click("blue", "Blue", "button"),
      type("label", "west"),
      click("apply", "Apply", "button", { afterText: "Applied" }),
    ],
    replays: [
      { texts: ["east"], secret: "", file: "a.txt" },
      { texts: ["north"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.label === spec.texts[0] && has(world, "Applied") ? null : "color",
  }),
  make({
    id: "profile",
    name: "Profile name",
    startUrl: "https://fixture.test/profile",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      type("first", "Ada"),
      type("last", "Lovelace"),
      click("save-profile", "Save", "button", { afterText: "Saved" }),
    ],
    replays: [
      { texts: ["Grace", "Hopper"], secret: "", file: "a.txt" },
      { texts: ["Lin", "Chen"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.first === spec.texts[0] && world.values.last === spec.texts[1] && has(world, "Saved") ? null : "profile",
  }),
  make({
    id: "drop-file",
    name: "Drop a file",
    startUrl: "https://fixture.test/drop-file",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      file("drop", "drop", "note.pdf"),
      click("save-drop", "Save", "button", { afterText: "Saved" }),
    ],
    replays: [
      { texts: [], secret: "", file: "one.txt" },
      { texts: [], secret: "", file: "two.txt" },
    ],
    oracle: (world, spec) => world.values.drop === spec.file && has(world, "Saved") ? null : "drop-file",
  }),
  make({
    id: "signup",
    name: "Sign in",
    startUrl: "https://fixture.test/signup",
    secrets: ["SuperSecretPassword!"],
    secretIds: ["signup-password"],
    human: [
      { id: "signup-password", gate: "login", target: "password" },
      { id: "signin-btn", gate: "login", target: "signin-btn" },
    ],
    events: [
      type("username", "ada"),
      type("password", "SuperSecretPassword!", { id: "signup-password", sensitive: true, gate: "login" }),
      click("signin-btn", "Sign in", "button", {
        gate: "login",
        beforeUrl: "https://fixture.test/signup",
        afterUrl: "https://fixture.test/secure",
      }),
    ],
    replays: [
      { texts: ["grace"], secret: "other-secret-1", file: "a.txt" },
      { texts: ["lin"], secret: "other-secret-2", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.username === spec.texts[0]
      && world.values.password === spec.secret
      && world.url.includes("/secure")
      && has(world, "Welcome " + spec.texts[0]) ? null : "signup",
  }),
  make({
    id: "long-abort",
    name: "Save a title after a long abort",
    startUrl: "https://fixture.test/long-abort",
    secrets: [],
    secretIds: [],
    human: [],
    noise: "long",
    events: [
      type("title", "Quilt"),
      click("save", "Save", "button", { afterText: "Saved" }),
    ],
    replays: [
      { texts: ["Wool"], secret: "", file: "a.txt" },
      { texts: ["Silk"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.title === spec.texts[0] && has(world, "Saved") ? null : "long-abort",
  }),
  make({
    id: "tabs-mix",
    name: "Interleaved tabs",
    startUrl: "https://fixture.test/tabs-mix",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      click("tab-ship", "Ship", "tab", { id: "ship-1" }),
      type("city", "Oslo"),
      click("tab-pay", "Pay", "tab", { id: "pay-1" }),
      type("note", "gift"),
      click("tab-ship", "Ship", "tab", { id: "ship-2" }),
      click("tab-pay", "Pay", "tab", { id: "pay-2" }),
      click("finish", "Finish", "button", { id: "finish-go", afterText: "Done" }),
    ],
    replays: [
      { texts: ["Rome", "wrap"], secret: "", file: "a.txt" },
      { texts: ["Lisbon", "card"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.city === spec.texts[0] && world.values.note === spec.texts[1] && has(world, "Done") ? null : "tabs-mix",
  }),
  make({
    id: "fare",
    name: "Fare with a fixed currency",
    startUrl: "https://fixture.test/fare",
    secrets: [],
    secretIds: [],
    human: [],
    events: [
      type("currency", "USD"),
      type("amount", "18"),
      click("buy", "Buy", "button", { afterText: "Bought" }),
    ],
    replays: [
      { texts: ["40"], secret: "", file: "a.txt" },
      { texts: ["6"], secret: "", file: "b.txt" },
    ],
    oracle: (world, spec) => world.values.currency === "USD" && world.values.amount === spec.texts[0] && has(world, "Bought") ? null : "fare",
  }),
];

let noiseSeq = 0;

function noiseId(): string {
  noiseSeq += 1;
  return `n${noiseSeq}`;
}

/** Detours, a retry, scrolls, a typo, irrelevant reads, and an aborted path. */
export function noisyTrail(events: readonly TrailEvent[], noise?: "long"): TrailEvent[] {
  const out: TrailEvent[] = [];
  const pushRead = (op: string) => {
    clock += 1;
    out.push({ id: noiseId(), ts: clock, kind: "read", op });
  };
  pushRead("screenshot");
  pushRead("move");
  pushRead("ax");
  for (const event of events) {
    if (event.op === "type" && !event.sensitive && !event.gate && event.value) {
      const wrong = `${event.value}x`;
      clock += 1;
      out.push({
        id: noiseId(),
        ts: clock,
        kind: "act",
        op: "type",
        value: wrong,
        identity: event.identity,
      });
      for (let i = 0; i < wrong.length; i++) {
        clock += 1;
        out.push({ id: noiseId(), ts: clock, kind: "act", op: "key", key: "Backspace" });
      }
    }
    clock += 1;
    out.push({ ...event, ts: clock });
    if (event.op === "click" && !event.gate) {
      clock += 1;
      out.push({ ...event, id: noiseId(), ts: clock });
    }
    if (event.op === "type") {
      clock += 1;
      out.push({ id: noiseId(), ts: clock, kind: "act", op: "scroll", provenance: { x: 1, y: 1, space: "viewport" } });
      pushRead("dom");
    }
  }
  clock += 1;
  out.push({
    id: noiseId(),
    ts: clock,
    kind: "act",
    op: "click",
    identity: dom("help", "button", "Help"),
  });
  if (noise === "long") pushLongAbort(out);
  else pushCoupon(out);
  return out;
}

function pushCoupon(out: TrailEvent[]): void {
  clock += 1;
  out.push({
    id: noiseId(),
    ts: clock,
    kind: "act",
    op: "click",
    identity: dom("coupon", "button", "Coupon"),
  });
  clock += 1;
  out.push({
    id: noiseId(),
    ts: clock,
    kind: "act",
    op: "type",
    value: "NOPE",
    identity: dom("couponcode", "textbox", "Code"),
  });
  clock += 1;
  out.push({
    id: noiseId(),
    ts: clock,
    kind: "act",
    op: "click",
    identity: dom("cancel", "button", "Cancel"),
  });
}

function pushAct(out: TrailEvent[], event: Omit<TrailEvent, "id" | "ts" | "kind">): void {
  clock += 1;
  out.push({ id: noiseId(), ts: clock, kind: "act", ...event });
}

/** Eight events, opened at Shipping and closed at Cancel. */
function pushLongAbort(out: TrailEvent[]): void {
  pushAct(out, { op: "click", identity: dom("shipping", "button", "Shipping") });
  pushAct(out, { op: "type", value: "1 Main", identity: dom("street", "textbox", "street") });
  pushAct(out, { op: "type", value: "Bergen", identity: dom("town", "textbox", "town") });
  pushAct(out, { op: "type", value: "West", identity: dom("region", "textbox", "region") });
  pushAct(out, { op: "type", value: "5003", identity: dom("code", "textbox", "code") });
  pushAct(out, { op: "click", identity: dom("gift", "button", "Gift") });
  pushAct(out, { op: "type", value: "hello there", identity: dom("card", "textbox", "card") });
  pushAct(out, { op: "click", identity: dom("cancel", "button", "Cancel") });
}
