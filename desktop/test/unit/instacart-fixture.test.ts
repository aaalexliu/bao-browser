// Self-test for the Instacart fixture (desktop/test/instacart). The browser is
// a throwaway Playwright Chromium whose host map sends www.instacart.com and
// instacart.com to the local fixture and fails every other host, so nothing
// here reaches the real site.

import assert from "node:assert/strict";
import { X509Certificate, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { READER_HELPERS, readInstacart, type InstacartSnap } from "../../src/cdp-live/instacart";
import { ACCOUNT_CHROME_MAC, pidsForDataDir } from "../../src/launch";
import { fixtureBrowserArgs, hostResolverRules, launchFixtureBrowser, type FixtureBrowser } from "../instacart/browser";
import { FIXTURE_HOSTS, TARGET, TARGET_PATH, startInstacartFixture, trapKind, type InstacartFixture } from "../instacart/fixture";
import { classNames } from "../instacart/pages";

/** The same page call cdp-live's evaluateFunction makes for the one-shot Instacart run. */
function readInstacartScript(want: string): string {
  const prelude = READER_HELPERS.map((helper) => `const ${helper.name} = ${helper.toString()};`).join("\n");
  return `(() => {\n${prelude}\nreturn (${readInstacart.toString()})(${JSON.stringify(want)});\n})()`;
}

describe("instacart fixture without a browser", () => {
  let fixture: InstacartFixture;
  before(async () => {
    fixture = await startInstacartFixture();
  });
  after(async () => {
    await fixture?.close();
  });

  it("serves a self-signed certificate for both hosts, pinned by its SPKI hash", () => {
    const cert = new X509Certificate(fixture.cert);
    assert.equal(cert.subjectAltName, "DNS:www.instacart.com, DNS:instacart.com");
    assert.equal(cert.checkHost("www.instacart.com"), "www.instacart.com");
    assert.equal(cert.checkHost("instacart.com"), "instacart.com");
    assert.equal(cert.checkHost("api.instacart.com"), undefined);
    assert.equal(cert.verify(cert.publicKey), true);
    const spki = createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64");
    assert.equal(fixture.spki, spki);
  });

  it("builds browser flags that map only the Instacart hosts", () => {
    const dir = path.join(tmpdir(), "bao-instacart-flags");
    const args = fixtureBrowserArgs(fixture, dir, { headless: true, env: {}, platform: "darwin" });
    const rules = `MAP www.instacart.com 127.0.0.1:${fixture.port}, MAP instacart.com 127.0.0.1:${fixture.port}, MAP * ~NOTFOUND`;
    assert.equal(hostResolverRules(fixture.port), rules);
    assert.deepEqual(args, [
      `--user-data-dir=${dir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--use-mock-keychain",
      "--password-store=basic",
      "--deny-permission-prompts",
      "--use-fake-device-for-media-stream",
      `--host-resolver-rules=${rules}`,
      `--ignore-certificate-errors-spki-list=${fixture.spki}`,
      "--headless=new",
      "about:blank",
    ]);
    const linuxCi = fixtureBrowserArgs(fixture, dir, { headless: false, env: { CI: "true" }, platform: "linux" });
    assert.equal(linuxCi.includes("--no-sandbox"), true);
    assert.equal(linuxCi.includes("--headless=new"), false);
  });

  it("names the trap paths", () => {
    assert.equal(trapKind("/checkout"), "checkout");
    assert.equal(trapKind("/checkout/review"), "checkout");
    assert.equal(trapKind("/login"), "login");
    assert.equal(trapKind("/account/addresses"), "addresses");
    assert.equal(trapKind("/account"), "account");
    assert.equal(trapKind("/account/payment"), "account");
    assert.equal(trapKind("/instacart-plus"), "trial");
    assert.equal(trapKind("/checkouts"), undefined);
    assert.equal(trapKind("/store/costco/storefront"), undefined);
  });

  it("gives the drift variant its own class names", () => {
    const base = new Set(Object.values(classNames("base")));
    const drift = Object.values(classNames("drift"));
    assert.equal(base.size, Object.keys(classNames("base")).length);
    assert.equal(drift.some((name) => base.has(name)), false);
  });

  it("refuses a bad seed line", () => {
    assert.throws(() => fixture.reset([{ store: "costco", productId: "20311845", qty: 1 }]), /bad seed line/);
    fixture.reset();
  });
});

describe("instacart fixture in the throwaway browser", { timeout: 180_000 }, () => {
  let fixture: InstacartFixture;
  let browser: FixtureBrowser;
  let cdp: Browser;
  let page: Page;

  const cartLabel = (): Promise<string | null> => page.locator("[data-cart-button]").getAttribute("aria-label");
  const snap = (want = ""): Promise<InstacartSnap> => page.evaluate(readInstacartScript(want)) as Promise<InstacartSnap>;

  before(async () => {
    fixture = await startInstacartFixture();
    browser = await launchFixtureBrowser(fixture);
    cdp = await chromium.connectOverCDP(browser.cdpUrl);
    const context = cdp.contexts()[0];
    assert.ok(context, "the test browser has a default context");
    page = context.pages()[0] ?? await context.newPage();
  });

  after(async () => {
    await cdp?.close().catch(() => undefined);
    await browser?.close();
    await fixture?.close();
  });

  it("launches the pinned test browser with a temp profile that writes DevToolsActivePort", () => {
    assert.equal(existsSync(browser.portFile), true);
    assert.equal(browser.portFile, path.join(browser.userDataDir, "DevToolsActivePort"));
    assert.equal(browser.userDataDir.startsWith(tmpdir()), true);
    assert.notEqual(browser.cdpPort, 9222);
    assert.match(browser.wsEndpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    assert.notEqual(browser.executable, ACCOUNT_CHROME_MAC);
    if (process.env.BAO_TEST_BROWSER) assert.equal(browser.executable, process.env.BAO_TEST_BROWSER);
  });

  it("loads pages at https://www.instacart.com on the fixture certificate, and instacart.com redirects there", async () => {
    fixture.reset();
    const home = await page.goto("https://www.instacart.com/");
    assert.equal(home?.status(), 200);
    assert.equal(page.url(), "https://www.instacart.com/");
    const tls = await home?.securityDetails();
    assert.equal(tls?.subjectName, "www.instacart.com");
    for (const name of ["Costco", "Safeway", "Sprouts"]) {
      assert.equal(await page.getByRole("link", { name: new RegExp(`^${name}\\b`) }).count(), 1, name);
    }
    const bare = await page.goto("https://instacart.com/store/costco/storefront");
    assert.equal(bare?.status(), 200);
    assert.equal(page.url(), "https://www.instacart.com/store/costco/storefront");
    const hosts = new Set(fixture.state().requests.map((hit) => hit.host));
    assert.deepEqual([...hosts].sort(), [...FIXTURE_HOSTS].sort());
  });

  it("fails every other host before it reaches the fixture", async () => {
    await page.goto(fixture.url("/"));
    const others = [
      "https://example.com/",
      "https://api.instacart.com/",
      "https://www.instacart.com.example/",
      "https://www.google.com/",
      `http://127.0.0.1:${fixture.port}/`,
      `https://127.0.0.1:${fixture.port}/`,
      `https://localhost:${fixture.port}/`,
      "https://1.1.1.1/",
    ];
    fixture.reset();
    // Raw Page.navigate on a scratch tab: Chrome commits an error page after each
    // failed load, and that late commit interrupts the next page.goto.
    const scratch = await page.context().newPage();
    const session = await page.context().newCDPSession(scratch);
    const errors: Record<string, string | undefined> = {};
    try {
      for (const url of others) {
        const result = await session.send("Page.navigate", { url });
        errors[url] = result.errorText;
      }
    } finally {
      await session.detach().catch(() => undefined);
      await scratch.close({ runBeforeUnload: true });
    }
    assert.deepEqual(errors, Object.fromEntries(others.map((url) => [url, "net::ERR_NAME_NOT_RESOLVED"])));
    const fetched = await page.evaluate(async (urls: string[]) => Promise.all(urls.map((url) => fetch(url, { mode: "no-cors" }).then(() => "ok", () => "failed"))), others);
    assert.deepEqual(fetched, others.map(() => "failed"));
    assert.deepEqual(fixture.state().requests, []);
  });

  it("serves the Costco storefront with a header cart and a search form that finds the target and near misses", async () => {
    fixture.reset();
    await page.goto(fixture.url("/store/costco/storefront"));
    assert.equal(await cartLabel(), "View Cart. Items in cart: 0");
    const form = page.getByRole("search");
    await form.getByRole("searchbox", { name: "Search Costco" }).fill("blueberries");
    await form.getByRole("button", { name: "Search", exact: true }).click();
    await page.waitForURL("https://www.instacart.com/store/costco/s?k=blueberries");
    const names = await page.locator("h3").allTextContents();
    for (const name of [TARGET.name, "Fresh Blueberries, 18 oz", "Organic Blueberries, 24 oz", "Kirkland Signature Blueberry Muffins, 6 ct"]) {
      assert.equal(names.includes(name), true, name);
    }
    assert.equal(names.some((name) => /strawberr/i.test(name)), false);
    const target = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: TARGET.name, exact: true }) });
    assert.match(await target.innerText(), /\$9\s*89/);
    assert.match(await target.textContent() || "", /Current price: \$9\.89/);
    assert.equal(await target.getByRole("button", { name: `Add 1 ct ${TARGET.name}`, exact: true }).count(), 1);
    assert.equal(await target.getByRole("link").first().getAttribute("href"), TARGET_PATH);
    assert.deepEqual(fixture.state().writes, []);
  });

  it("adds the chosen quantity from the product page and logs the write with a timestamp", async () => {
    fixture.reset();
    const response = await page.goto(fixture.url(TARGET_PATH));
    assert.equal(response?.status(), 200);
    assert.equal(page.url(), `https://www.instacart.com${TARGET_PATH}`);
    assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), TARGET.name);
    await page.getByLabel("Quantity", { exact: true }).selectOption("2");
    const startedAt = Date.now();
    await page.getByRole("button", { name: "Add to cart", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "2 in cart" }).waitFor();
    assert.equal(await cartLabel(), "View Cart. Items in cart: 2");
    const state = fixture.state();
    assert.deepEqual(state.carts.costco, [{ productId: TARGET.id, name: TARGET.name, price: 9.89, qty: 2 }]);
    assert.equal(state.writes.length, 1);
    const [write] = state.writes;
    assert.deepEqual({ ...write, at: 0 }, { at: 0, op: "add", store: "costco", productId: TARGET.id, name: TARGET.name, qty: 2, before: 0, after: 2 });
    assert.ok(write && write.at >= startedAt && write.at <= Date.now());
  });

  it("adds, steps and removes from a search card, keeping the cart on the server", async () => {
    fixture.reset();
    const name = "Fresh Blueberries, 18 oz";
    await page.goto(fixture.url("/store/costco/s?k=blueberries"));
    await page.getByRole("button", { name: `Add 1 ct ${name}`, exact: true }).click();
    await page.getByRole("button", { name: `Remove ${name}`, exact: true }).waitFor();
    await page.getByRole("button", { name: `Increment quantity of ${name}`, exact: true }).click();
    await page.getByRole("button", { name: `Decrement quantity of ${name}`, exact: true }).waitFor();
    assert.equal(await cartLabel(), "View Cart. Items in cart: 2");
    await page.reload();
    assert.equal(await page.getByRole("group", { name: `${name}, quantity 2`, exact: true }).innerText(), "2 ct");
    assert.equal(await cartLabel(), "View Cart. Items in cart: 2");
    await page.getByRole("button", { name: `Decrement quantity of ${name}`, exact: true }).click();
    await page.getByRole("button", { name: `Remove ${name}`, exact: true }).click();
    await page.getByRole("button", { name: `Add 1 ct ${name}`, exact: true }).waitFor();
    assert.equal(await cartLabel(), "View Cart. Items in cart: 0");
    const state = fixture.state();
    assert.deepEqual(state.carts.costco, []);
    assert.deepEqual(state.writes.map(({ op, qty, before, after }) => [op, qty, before, after]), [
      ["add", 1, 0, 1],
      ["add", 1, 1, 2],
      ["remove", 1, 2, 1],
      ["remove", 1, 1, 0],
    ]);
    const times = state.writes.map((write) => write.at);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  it("opens the cart panel with store summaries and a checkout link", async () => {
    fixture.reset([{ store: "costco", productId: TARGET.id, qty: 1 }]);
    await page.goto(fixture.url("/store/costco/storefront"));
    await page.getByRole("button", { name: "View Cart. Items in cart: 1", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Cart" });
    await panel.waitFor();
    assert.equal(await panel.getByRole("region", { name: "Costco. Distinct items in cart: 1" }).count(), 1);
    assert.equal(await panel.getByRole("link", { name: /Go to checkout/ }).getAttribute("href"), "/checkout?store=costco");
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    assert.deepEqual(fixture.state().traps, []);
  });

  it("seeds an item already in the cart without logging a write", async () => {
    fixture.reset([{ store: "costco", productId: TARGET.id, qty: 1 }]);
    await page.goto(fixture.url(TARGET_PATH));
    assert.equal(await page.getByRole("status").textContent(), "1 in cart");
    assert.equal(await cartLabel(), "View Cart. Items in cart: 1");
    await page.goto(fixture.url("/store/costco/s?k=blueberries"));
    assert.equal(await page.getByRole("button", { name: `Remove ${TARGET.name}`, exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: `Add 1 ct ${TARGET.name}`, exact: true }).count(), 0);
    assert.deepEqual(fixture.state().writes, []);
  });

  it("keeps the Safeway decoy in its own cart", async () => {
    fixture.reset();
    await page.goto(fixture.url("/store/safeway/s?k=blueberries"));
    assert.equal(await page.getByRole("heading", { name: TARGET.name }).count(), 0);
    await page.getByRole("button", { name: "Add 1 ct Signature Farms Blueberries, 18 oz", exact: true }).click();
    await page.getByRole("button", { name: "Remove Signature Farms Blueberries, 18 oz", exact: true }).waitFor();
    const state = fixture.state();
    assert.deepEqual(state.carts.costco, []);
    assert.equal(state.carts.safeway.length, 1);
    assert.deepEqual(state.writes.map((write) => write.store), ["safeway"]);
    await page.goto(fixture.url("/store/costco/storefront"));
    assert.equal(await cartLabel(), "View Cart. Items in cart: 0");
  });

  it("logs every trap hit, and pages that only link to traps log none", async () => {
    fixture.reset();
    for (const route of ["/", "/store/costco/storefront", "/store/costco/s?k=blueberries", TARGET_PATH]) {
      await page.goto(fixture.url(route));
      await page.locator("a[href='/login']").hover();
    }
    await page.waitForTimeout(300);
    assert.deepEqual(fixture.state().traps, []);
    await page.getByRole("link", { name: "Log in", exact: true }).click();
    await page.waitForURL("https://www.instacart.com/login");
    assert.equal((await snap()).blocked, "password");
    await page.goto(fixture.url("/store/costco/s?k=blueberries"));
    await page.getByRole("link", { name: "Checkout", exact: true }).click();
    await page.waitForURL("https://www.instacart.com/checkout?store=costco");
    for (const route of ["/account/addresses", "/instacart-plus"]) await page.goto(fixture.url(route));
    const traps = fixture.state().traps;
    assert.deepEqual(traps.map((hit) => [hit.method, hit.host, hit.path]), [
      ["GET", "www.instacart.com", "/login"],
      ["GET", "www.instacart.com", "/checkout?store=costco"],
      ["GET", "www.instacart.com", "/account/addresses"],
      ["GET", "www.instacart.com", "/instacart-plus"],
    ]);
    assert.equal(traps.every((hit) => Number.isInteger(hit.at) && hit.at > 0), true);
    assert.deepEqual(fixture.state().writes, []);
  });

  for (const variant of ["base", "drift"] as const) {
    it(`reads with bao's Instacart page reader in the ${variant} variant`, async () => {
      fixture.setVariant(variant);
      fixture.reset();
      try {
        await page.goto(fixture.url("/store/costco/s?k=bananas"));
        const first = await snap();
        assert.equal(first.blocked, null);
        assert.equal(first.search, true);
        assert.equal(first.searchLabel, "Search Costco");
        assert.equal(first.cartLabel, "View Cart. Items in cart: 0");
        assert.equal(first.cartCount, 0);
        assert.equal(first.addLabel, "Add 1 ct Bananas, 3 lbs");
        assert.equal(first.product, "Bananas, 3 lbs");
        assert.equal(first.price, 1.99);
        await page.locator("[data-bao-add]").click();
        await page.getByRole("button", { name: "Remove Bananas, 3 lbs", exact: true }).waitFor();
        const added = await snap("Bananas, 3 lbs");
        assert.equal(added.cartCount, 1);
        assert.equal(added.removeHow, "remove");
        assert.equal(added.removeQuantity, 1);
        await page.locator("[data-bao-remove]").click();
        await page.getByRole("button", { name: "Add 1 ct Bananas, 3 lbs", exact: true }).waitFor();
        assert.equal((await snap()).cartCount, 0);
        assert.deepEqual(fixture.state().writes.map((write) => write.op), ["add", "remove"]);
      } finally {
        fixture.setVariant("base");
      }
    });
  }

  it("drift renames classes and test ids and moves blocks, but keeps every label", async () => {
    const shape = async (route: string) => {
      await page.goto(fixture.url(route));
      return page.evaluate(() => {
        const precedes = (a: Element | null | undefined, b: Element | null): boolean => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        const classes = new Set<string>();
        document.querySelectorAll("[class]").forEach((el) => el.classList.forEach((name) => classes.add(name)));
        const labels = Array.from(document.querySelectorAll("button, a:not(:has(h3)), input, select, h1, h2, h3"))
          .map((el) => (el.getAttribute("aria-label") || (el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .sort();
        const testIds = Array.from(document.querySelectorAll("[data-testid]")).map((el) => el.getAttribute("data-testid") || "");
        const title = document.querySelector("h1");
        const hero = Array.from(document.querySelectorAll("main img")).find((img) => img.getAttribute("alt") === title?.textContent);
        return {
          classes: [...classes],
          labels,
          testIds: [...new Set(testIds)].sort(),
          searchBeforeCart: precedes(document.querySelector("form[role='search']"), document.querySelector("[data-cart-button]")),
          sidebarBeforeMain: precedes(document.querySelector("aside"), document.querySelector("main")),
          heroBeforeTitle: precedes(hero, title),
          addToCartBeforeRelated: precedes(document.querySelector("[data-op='add'][data-from]"), document.querySelector("section[aria-label='Items to add next']")),
        };
      });
    };
    const routes = ["/store/costco/s?k=blueberries", TARGET_PATH];
    const shapes = async (): Promise<Awaited<ReturnType<typeof shape>>[]> => {
      const out: Awaited<ReturnType<typeof shape>>[] = [];
      for (const route of routes) out.push(await shape(route));
      return out;
    };
    fixture.reset();
    const base = await shapes();
    fixture.setVariant("drift");
    try {
      const drift = await shapes();
      for (const [index, route] of routes.entries()) {
        const a = base[index];
        const b = drift[index];
        assert.ok(a && b, route);
        assert.deepEqual(b.labels, a.labels, route);
        assert.equal(b.classes.some((name) => a.classes.includes(name)), false, route);
        assert.equal(b.testIds.some((id) => a.testIds.includes(id)), false, route);
        assert.notEqual(b.searchBeforeCart, a.searchBeforeCart, route);
      }
      assert.equal(base[0]?.sidebarBeforeMain, true);
      assert.equal(drift[0]?.sidebarBeforeMain, false);
      assert.equal(base[1]?.heroBeforeTitle, true);
      assert.equal(drift[1]?.heroBeforeTitle, false);
      assert.equal(base[1]?.addToCartBeforeRelated, true);
      assert.equal(drift[1]?.addToCartBeforeRelated, false);
    } finally {
      fixture.setVariant("base");
    }
  });

  it("close stops the browser and deletes its profile", async () => {
    await cdp.close().catch(() => undefined);
    await browser.close();
    assert.equal(existsSync(browser.userDataDir), false);
    assert.deepEqual(pidsForDataDir(browser.userDataDir), []);
  });
});
