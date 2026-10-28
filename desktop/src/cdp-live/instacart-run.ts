import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkboxReach, mayClickAllow, ALLOW_CLICK_WINDOW_MS } from "./consent";
import { INSTACART_HOSTS } from "./allowlist";
import { AxUnavailable, checkboxState, chromeHelper, chromeTree, pressAllow } from "./ax";
import { openLiveWindow, type CdpLiveDriver, type PageObservation } from "./driver";
import { readDevToolsActivePort } from "./endpoint";
import {
  STAPLE,
  addLabelOk,
  addProductName,
  cartCountFromLabel,
  cartLabelOk,
  cartRestored,
  clickForbidden,
  removeLabelOk,
  searchLabelOk,
  stapleNameOk,
  readInstacart,
  type InstacartSnap,
} from "./instacart";
import { classifyPage } from "../v1/page-class";
import { connectCdp, type CdpSocket } from "./socket";

const HOME = "https://www.instacart.com/";
const CLICK_CAP = 6;

class NeedsHuman extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "NeedsHuman";
  }
}

interface StepNote {
  name: string;
  status: "passed" | "needs_human" | "failed";
  ms: number;
  code?: string;
}

interface Saved {
  phase: "counted" | "added" | "done" | "uncertain";
  countBefore: number;
  product: string;
  countAfterAdd?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progress(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .slice(0, 240);
}

async function readState(file: string): Promise<Saved | null> {
  const raw = await readFile(file, "utf8").catch(() => "");
  if (!raw.trim()) return null;
  const parsed = JSON.parse(raw) as Saved;
  if (!parsed || typeof parsed.countBefore !== "number" || typeof parsed.product !== "string") return null;
  if (!stapleNameOk(parsed.product)) return null;
  return parsed;
}

async function writeState(file: string, state: Saved): Promise<void> {
  await writeFile(file, `${JSON.stringify(state)}\n`);
}

async function snap(driver: CdpLiveDriver, want: string): Promise<InstacartSnap> {
  return driver.evaluateFunction<InstacartSnap>(readInstacart, want, [
    clickForbidden,
    stapleNameOk,
    searchLabelOk,
    addProductName,
    addLabelOk,
    cartLabelOk,
    cartCountFromLabel,
    removeLabelOk,
  ]);
}

function safeTrustText(text: string): string {
  const clean = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "");
  if (/@|\bstreet\b|\bavenue\b|\broad\b|\bapt\b/i.test(clean)) return "";
  return clean.slice(0, 60);
}

async function until(
  driver: CdpLiveDriver,
  want: string,
  ready: (page: InstacartSnap) => boolean,
  timeoutMs: number,
): Promise<InstacartSnap> {
  const deadline = Date.now() + timeoutMs;
  let last: InstacartSnap | undefined;
  while (Date.now() < deadline) {
    const page = await snap(driver, want).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (/allowlist refused/.test(message)) throw err;
      return undefined;
    });
    if (page) {
      last = page;
      if (page.blocked || ready(page)) return page;
    }
    await sleep(500);
  }
  if (!last) throw new NeedsHuman("page-lost");
  return last;
}

async function wall(driver: CdpLiveDriver): Promise<string | null> {
  const signals = await driver.pageSignals();
  const decision = classifyPage({
    ...signals,
    cookies: [],
    responses: [],
    startedUrl: HOME,
  });
  if (decision.class === "bot_wall" || decision.class === "login_wall") return decision.class;
  return null;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const evidence = path.join(root, ".evidence");
  const axLog = path.join(evidence, "cdp-live-ax.jsonl");
  const stateFile = path.join(evidence, "instacart-once-state.json");
  const outFile = path.join(evidence, "instacart-once.json");
  await mkdir(evidence, { recursive: true });
  const prior = await readState(stateFile);
  if (prior?.phase === "done" || prior?.phase === "uncertain") {
    const finished = prior.phase === "done";
    const body = {
      status: finished ? "passed" : "needs_human",
      code: finished ? undefined : "left-in-cart",
      countBefore: prior.countBefore,
      countAfterAdd: prior.countAfterAdd ?? null,
      countAfterRemove: finished ? prior.countBefore : null,
      restored: finished,
      product: prior.product,
      clicks: 0,
      note: "did not open Chrome",
    };
    await writeFile(outFile, `${JSON.stringify(body, null, 2)}\n`);
    progress(`instacart state is ${prior.phase}; not opening Chrome`);
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    if (!finished) process.exitCode = 2;
    return;
  }

  const helper = chromeHelper();
  progress("helper permissions");
  const perms = await helper.permissions(false);
  if (perms.prompted) throw new Error("helper asked for a permission prompt");
  if (!perms.accessibility) throw new Error("BaoOSHelper accessibility is not granted");
  progress("reading the remote-debugging checkbox");
  const box = await checkboxState(helper);
  if (checkboxReach(box.summary) === "stop") {
    throw new AxUnavailable("BaoOSHelper cannot see a Chrome window", box.summary);
  }
  if (box.on === false) throw new NeedsHuman("remote-debugging-off");
  const dialogPresentBeforeConnect = box.summary.dialog.present || box.summary.dialog.buttonCount > 0;
  if (dialogPresentBeforeConnect) {
    throw new AxUnavailable("Allow dialog was already up; not connecting and not clicking", box.summary);
  }
  progress("reading DevToolsActivePort");
  const endpoint = await readDevToolsActivePort();
  progress(`browser socket on port ${endpoint.port}`);
  const abort = new AbortController();
  const connectionStartedAt = Date.now();
  let opened = false;
  const pending = connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 200_000, signal: abort.signal })
    .then((socket) => {
      opened = true;
      return socket;
    });
  pending.catch(() => undefined);
  let last = box.summary;
  let clickedAt: number | undefined;
  let allowWindow = "";
  const deadline = connectionStartedAt + ALLOW_CLICK_WINDOW_MS;
  while (Date.now() < deadline && !opened) {
    progress("reading AX for the Allow dialog");
    const tree = await chromeTree(helper);
    last = tree.summary;
    if (opened) break;
    if (mayClickAllow({
      openedByBao: true,
      connectionStartedAt,
      now: Date.now(),
      dialogPresentBeforeConnect,
      dialog: tree.summary.dialog,
    })) {
      if (opened) break;
      progress("pressing Allow");
      const pressed = await pressAllow(helper, box.pid, axLog);
      clickedAt = pressed.at;
      allowWindow = pressed.window;
      break;
    }
  }
  if (clickedAt == null && !opened) {
    abort.abort();
    await pending.catch(() => undefined);
    throw new AxUnavailable("BaoOSHelper cannot see the Allow remote debugging dialog", last);
  }
  const cdp: CdpSocket = await pending;
  const connectToAllowMs = clickedAt == null ? null : clickedAt - connectionStartedAt;
  progress(`socket open; connect-to-Allow ${connectToAllowMs == null ? "not clicked" : `${connectToAllowMs}ms`}`);

  const steps: StepNote[] = [];
  let clicks = 0;
  let countBefore: number | null = prior?.phase === "added" ? prior.countBefore : null;
  let countAfterAdd: number | null = prior?.countAfterAdd ?? null;
  let countAfterRemove: number | null = null;
  let product = prior?.phase === "added" ? prior.product : "";
  let price: number | null = null;
  let observed: PageObservation | undefined;
  let code = "";
  let status: "passed" | "needs_human" | "failed" = "failed";
  let hints: string[] = [];
  let persisted: Saved["phase"] | "" = prior?.phase === "added" ? "added" : "";
  const remember = (page: InstacartSnap | undefined): void => {
    if (page?.hints?.length) hints = page.hints.slice(0, 8);
  };

  const note = (name: string, started: number, stepStatus: StepNote["status"], stepCode?: string): void => {
    steps.push({ name, status: stepStatus, ms: Date.now() - started, code: stepCode });
  };

  const clickMarked = async (live: CdpLiveDriver, selector: string, label: string, ok: boolean, name: string): Promise<void> => {
    if (!ok || clicks >= CLICK_CAP) throw new NeedsHuman(clicks >= CLICK_CAP ? "too-many-clicks" : "refused-click");
    const started = Date.now();
    await live.clickCss(selector);
    clicks += 1;
    note(name, started, "passed");
  };

  let driver: CdpLiveDriver | undefined;
  try {
    driver = await openLiveWindow(cdp, INSTACART_HOSTS);
    const openStarted = Date.now();
    await driver.goto(HOME, 30_000);
    const blockedWall = await wall(driver).catch(() => null);
    if (blockedWall) throw new NeedsHuman(blockedWall);
    note("open", openStarted, "passed");

    if (prior?.phase === "added") {
      progress("resuming at remove; not adding another item");
    } else {
      const landed = await until(driver, "", (page) => page.search && !page.cartAmbiguous, 25_000);
      remember(landed);
      if (landed.blocked) throw new NeedsHuman(landed.blocked);
      if (landed.cartAmbiguous) throw new NeedsHuman("cart-ambiguous");
      if (!landed.search || !searchLabelOk(landed.searchLabel)) throw new NeedsHuman("search-missing");

      const searchStarted = Date.now();
      await clickMarked(driver, "[data-bao-search]", landed.searchLabel, searchLabelOk(landed.searchLabel), "search");
      const focused = await snap(driver, "");
      remember(focused);
      if (focused.blocked) throw new NeedsHuman(focused.blocked);
      if (!focused.search || !searchLabelOk(focused.searchLabel)) throw new NeedsHuman("search-missing");
      await driver.key("cmd+a");
      await driver.insertText(STAPLE);
      await driver.key("Enter");
      note("type-search", searchStarted, "passed");

      const found = await until(driver, "", (page) => stapleNameOk(page.product) && addLabelOk(page.addLabel) && page.cartCount != null && !page.cartAmbiguous, 25_000);
      remember(found);
      if (found.blocked) throw new NeedsHuman(found.blocked);
      if (found.cartAmbiguous) throw new NeedsHuman("cart-ambiguous");
      if (!stapleNameOk(found.product) || !addLabelOk(found.addLabel)) throw new NeedsHuman("staple-missing");
      if (found.cartCount == null) throw new NeedsHuman("cart-count");
      countBefore = found.cartCount;
      await writeState(stateFile, { phase: "counted", countBefore, product: "" });
      product = found.product;
      price = found.price;
      await clickMarked(driver, "[data-bao-add]", found.addLabel, addLabelOk(found.addLabel), "add");
      const added = await until(driver, product, (page) => page.cartCount === (countBefore as number) + 1, 12_000);
      remember(added);
      countAfterAdd = added.cartCount;
      if (countBefore != null && countAfterAdd === countBefore + 1) {
        await writeState(stateFile, { phase: "added", countBefore, product, countAfterAdd });
        persisted = "added";
      }
      if (added.blocked) throw new NeedsHuman(added.blocked);
      if (countAfterAdd !== countBefore + 1) throw new NeedsHuman("cart-not-incremented");
    }

    const opening = await snap(driver, product);
    remember(opening);
    if (opening.blocked) throw new NeedsHuman(opening.blocked);
    if (!removeLabelOk(opening.removeLabel, opening.removeHow, opening.removeQuantity)) {
      if (opening.cartAmbiguous || !cartLabelOk(opening.cartLabel)) throw new NeedsHuman("cart-missing");
      await clickMarked(driver, "[data-bao-cart]", opening.cartLabel, cartLabelOk(opening.cartLabel), "open-cart");
    }

    const removable = await until(driver, product, (page) => removeLabelOk(page.removeLabel, page.removeHow, page.removeQuantity), 15_000);
    remember(removable);
    if (removable.blocked) throw new NeedsHuman(removable.blocked);
    if (!removeLabelOk(removable.removeLabel, removable.removeHow, removable.removeQuantity)) {
      throw new NeedsHuman("cannot-remove");
    }
    await clickMarked(
      driver,
      "[data-bao-remove]",
      removable.removeLabel,
      removeLabelOk(removable.removeLabel, removable.removeHow, removable.removeQuantity),
      "remove",
    );
    const restoredPage = await until(driver, product, (page) => page.cartCount === countBefore, 12_000);
    remember(restoredPage);
    if (restoredPage.blocked) throw new NeedsHuman(restoredPage.blocked);
    countAfterRemove = restoredPage.cartCount;
    if (countBefore == null || countAfterAdd == null || countAfterRemove == null || !cartRestored(countBefore, countAfterAdd, countAfterRemove)) {
      throw new NeedsHuman("cart-not-restored");
    }
    observed = await driver.observe();
    status = "passed";
    await writeState(stateFile, { phase: "done", countBefore, product, countAfterAdd });
    persisted = "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NeedsHuman) {
      code = err.code;
      status = "needs_human";
    } else if (/allowlist refused/.test(message)) {
      code = /blocked-path/.test(message) ? "blocked-path" : "off-host";
      status = "needs_human";
    } else {
      code = safeError(err);
      status = "failed";
    }
    progress(`stopped ${status} ${code}`);
    if (driver) {
      const last = await snap(driver, product).catch(() => undefined);
      remember(last);
      observed = await driver.observe().catch(() => undefined);
    }
    if (persisted !== "added" && persisted !== "done" && countBefore != null && stapleNameOk(product) && steps.some((step) => step.name === "add")) {
      await writeState(stateFile, { phase: "uncertain", countBefore, product, countAfterAdd: countAfterAdd ?? undefined });
    }
  } finally {
    await driver?.end().catch(() => undefined);
  }

  progress("reading the automation banner");
  const during = (await chromeTree(helper)).summary.banner;
  cdp.close();
  await sleep(500);
  const after = (await chromeTree(helper)).summary.banner;
  const trust = (observed?.trust || []).map((event) => ({
    isTrusted: event.isTrusted === true,
    tag: event.tag,
    text: safeTrustText(event.text),
  }));
  const body = {
    status,
    code: code || undefined,
    countBefore,
    countAfterAdd,
    countAfterRemove,
    restored: countBefore != null && countAfterAdd != null && countAfterRemove != null
      && cartRestored(countBefore, countAfterAdd, countAfterRemove),
    product: stapleNameOk(product) ? product : "",
    price,
    clicks,
    hints,
    connectToAllowMs,
    allowWindow,
    webdriver: observed ? observed.webdriver : null,
    host: observed?.host || "",
    trusted: trust.length ? trust.every((event) => event.isTrusted) : null,
    trust,
    steps,
    banner: { during: during.visible, duringText: during.text, afterClose: after.visible },
    checkboxOn: box.on,
    screenCapture: false,
  };
  await writeFile(outFile, `${JSON.stringify(body, null, 2)}\n`);
  progress(`wrote ${path.basename(outFile)}`);
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  if (status !== "passed") process.exitCode = 2;
}

if (require.main === module) {
  main().catch((err) => {
    const summary = err instanceof AxUnavailable ? err.summary : undefined;
    process.stderr.write(`${safeError(err)}\n`);
    if (summary) process.stderr.write(`${JSON.stringify(summary)}\n`);
    process.exit(1);
  });
}
