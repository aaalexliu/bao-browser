// The page class is decided before a heal. Each class is a fixture, and a
// wall stops the run with no heal and no model call.

import assert from "node:assert/strict";
import test from "node:test";
import { actBar, healInbox, runViewer, type RunSummary, type WorkflowSummary } from "../../src/app/views";
import { makeAsk } from "../../src/v1/human-ask";
import { judgeSignedIn } from "../../src/login-import/probe";
import { classifyPage, siteName, type PageSignals } from "../../src/v1/page-class";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import type { Identity, WorkflowStep, WorkflowV2 } from "../../src/v1/schema";

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function step(partial: Partial<WorkflowStep> & Pick<WorkflowStep, "id" | "action">): WorkflowStep {
  return { index: 0, label: partial.label || partial.action, surface: "dom", timeoutMs: 0, ...partial };
}

function doc(startUrl: string, steps: WorkflowStep[]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf",
    name: "Fixture",
    startUrl,
    createdAt: 1,
    inputs: [],
    steps: steps.map((item, index) => ({ ...item, index })),
  };
}

function tree(nodes: Identity[]): LiveTree {
  return { nodes, texts: [], values: [] };
}

function fake(pages: LiveTree[], signals?: PageSignals): Driver & { clicks: string[] } {
  let n = 0;
  const clicks: string[] = [];
  const current = () => pages[Math.min(n, pages.length - 1)]!;
  return {
    clicks,
    tree: async () => current(),
    snapshot: async () => ({ dom: "fixture" }),
    click: async (node) => {
      clicks.push(node.testId || node.id || node.text || node.role);
      n += 1;
    },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
    pageSignals: signals ? async () => signals : undefined,
  };
}

const clickApply = step({ id: "apply", action: "click", label: "Click Apply", identity: ident({ testId: "apply", text: "Apply" }) });

function countingHeal() {
  let proposed = 0;
  return {
    proposed: () => proposed,
    heal: {
      available: () => true,
      propose: async () => {
        proposed += 1;
        return null;
      },
    },
  };
}

test("a vendor challenge is a bot wall and a plain 200 is not", () => {
  const cases: { vendor: string; signals: PageSignals }[] = [
    { vendor: "reCAPTCHA", signals: { iframeSrcs: ["https://www.google.com/recaptcha/api2/anchor"], texts: ["I'm not a robot"] } },
    { vendor: "hCaptcha", signals: { markers: ["h-captcha"], iframeSrcs: ["https://newassets.hcaptcha.com/captcha"] } },
    { vendor: "Turnstile", signals: { markers: ["cf-turnstile"], iframeSrcs: ["https://challenges.cloudflare.com/turnstile"] } },
    { vendor: "Cloudflare", signals: { title: "Just a moment...", texts: ["Checking your browser before accessing the site"] } },
    { vendor: "Akamai", signals: { title: "Access Denied", texts: ["Reference #18.6f4a"], markers: ["akamai"] } },
    { vendor: "Imperva", signals: { iframeSrcs: ["/_Incapsula_Resource"], texts: ["Incapsula incident ID: 123"] } },
    { vendor: "PerimeterX", signals: { markers: ["px-captcha"], texts: ["Press & Hold"] } },
    { vendor: "DataDome", signals: { iframeSrcs: ["https://geo.captcha-delivery.com/captcha"], markers: ["datadome"] } },
    { vendor: "captcha", signals: { texts: ["Verify you are human"] } },
  ];
  for (const item of cases) {
    const decision = classifyPage(item.signals);
    assert.equal(decision.class, "bot_wall", item.vendor);
    assert.equal(decision.vendor, item.vendor);
    assert.ok(decision.evidence.length > 0, item.vendor);
  }
  const blocked = classifyPage({
    url: "https://shop.example/checkout",
    responses: [{ url: "https://shop.example/checkout", status: 403, headers: [{ name: "cf-mitigated", value: "challenge" }] }],
  });
  assert.equal(blocked.class, "bot_wall");
  assert.equal(blocked.vendor, "Cloudflare");
  assert.equal(classifyPage({
    url: "https://shop.example/home",
    cookies: [{ name: "visid_incap_1" }],
    responses: [{ url: "https://shop.example/home", status: 200, headers: [{ name: "x-iinfo", value: "1" }] }],
    texts: ["Your account"],
  }).class, "changed");
  assert.equal(classifyPage({ title: "Access Denied", texts: ["Try again later"] }).class, "changed");
});

test("a member url that settles on a login url is a login wall, with no http redirect", () => {
  const decision = classifyPage({
    startedUrl: "https://usa.experian.com/member",
    url: "https://usa.experian.com/login/index?refUrl=%2Fmember",
    responses: [{ method: "POST", url: "https://usa.experian.com/api/router/graphql", status: 403 }],
    texts: ["Sign in"],
  });
  assert.equal(decision.class, "login_wall");
  assert.equal(decision.reason, "session expired");
  const detail = decision.evidence.map((item) => item.detail).join("\n");
  assert.match(detail, /login\/index\?refUrl=/);
  assert.match(detail, /POST \/api\/router\/graphql 403/);
  assert.equal(classifyPage({
    startedUrl: "https://usa.experian.com/member",
    url: "https://usa.experian.com/member",
    responses: [{ method: "POST", url: "https://usa.experian.com/api/router/graphql", status: 403 }],
  }).class, "changed");
  assert.equal(classifyPage({
    startedUrl: "https://usa.experian.com/member",
    url: "https://usa.experian.com/account",
    hasPassword: true,
    recordedPassword: false,
  }).class, "login_wall");
  assert.equal(classifyPage({
    startedUrl: "http://127.0.0.1/fixture",
    url: "http://127.0.0.1/fixture?interstitial=1",
    hasPassword: true,
    recordedPassword: false,
    texts: ["Waiting to apply"],
  }).class, "changed");
  assert.equal(classifyPage({
    url: "https://usa.experian.com/login",
    hasPassword: true,
    recordedPassword: true,
    recordedLogin: true,
    startedUrl: "https://usa.experian.com/login",
  }).class, "changed");
  assert.equal(classifyPage({ texts: ["Your session expired"] }).class, "login_wall");
  const judged = judgeSignedIn({
    finalUrl: "https://usa.experian.com/login/index?refUrl=%2Fmember",
    startedUrl: "https://usa.experian.com/member",
    selectorFound: false,
    bodyText: "",
  }, {});
  assert.equal(judged.signedIn, false);
  assert.equal(judged.how, "login-wall");
  assert.equal(judgeSignedIn({
    finalUrl: "https://usa.experian.com/login/index?refUrl=%2Fmember",
    startedUrl: "https://usa.experian.com/member",
    selectorFound: true,
    bodyText: "Welcome back",
  }, { selector: "#account", text: "Welcome back" }).signedIn, true);
  assert.equal(siteName("https://usa.experian.com/member"), "Experian");
});

test("cookie, newsletter, ad, and chat clutter name a close control", () => {
  const cookie = classifyPage({
    texts: ["We use cookies"],
    nodes: [{ role: "button", text: "Accept", testId: "accept-cookies" }],
  });
  assert.equal(cookie.class, "clutter");
  assert.equal(cookie.reason, "cookie banner");
  const newsletter = classifyPage({
    texts: ["Sign up for our newsletter"],
    nodes: [{ role: "button", text: "No thanks" }],
  });
  assert.equal(newsletter.class, "clutter");
  assert.equal(newsletter.reason, "newsletter");
  const ad = classifyPage({
    texts: ["This is an advertisement"],
    closes: [{ text: "Close" }],
  });
  assert.equal(ad.class, "clutter");
  assert.equal(ad.reason, "ad");
  const chat = classifyPage({
    texts: ["Chat with us"],
    nodes: [{ role: "button", text: "Close" }],
  });
  assert.equal(chat.class, "clutter");
  assert.equal(chat.reason, "chat");
  assert.equal(classifyPage({
    iframeSrcs: ["https://widget.intercom.io/widget"],
    texts: ["Your account is ready"],
  }).class, "changed");
  const modal = classifyPage({
    texts: ["This is a modal window"],
    closes: [{ text: "Close" }],
  });
  assert.equal(modal.class, "clutter");
  assert.equal(modal.reason, "modal");
  assert.equal(modal.dismiss?.text, "Close");
});

test("a bot wall and a login wall stop before the step, and clutter retries once", async () => {
  const quiet = countingHeal();
  const botDriver = fake(
    [tree([ident({ testId: "apply", text: "Apply" })])],
    { iframeSrcs: ["https://www.google.com/recaptcha/enterprise/anchor"], texts: ["I'm not a robot"] },
  );
  const bot = await replay(doc("https://shop.example/cart", [clickApply]), {}, botDriver, { heal: quiet.heal });
  assert.equal(bot.status, "paused");
  assert.equal(bot.pausedKind, "wall");
  assert.equal(bot.pageClasses.at(-1)?.class, "bot_wall");
  assert.equal(bot.pageClasses.at(-1)?.vendor, "reCAPTCHA");
  assert.equal(bot.heals.length, 0);
  assert.equal(bot.modelCalls, 0);
  assert.equal(botDriver.clicks.length, 0);
  assert.match(bot.ask?.instruction || "", /bot check/);
  assert.match(bot.ask?.instruction || "", /Continue/);

  const loginDriver = fake(
    [tree([ident({ testId: "apply", text: "Apply" })])],
    {
      url: "https://usa.experian.com/login/index?refUrl=%2Fmember",
      responses: [{ method: "POST", url: "https://usa.experian.com/api/router/graphql", status: 403 }],
    },
  );
  const login = await replay(doc("https://usa.experian.com/member", [clickApply]), {}, loginDriver, { heal: quiet.heal });
  assert.equal(login.status, "paused");
  assert.equal(login.pausedKind, "wall");
  assert.equal(login.pageClasses.at(-1)?.class, "login_wall");
  assert.match(login.pageClasses.at(-1)?.evidence.map((item) => item.detail).join("\n") || "", /POST \/api\/router\/graphql 403/);
  assert.equal(login.heals.length, 0);
  assert.equal(login.modelCalls, 0);
  assert.equal(loginDriver.clicks.length, 0);
  assert.equal(login.ask?.instruction, "Experian is asking you to sign in. Finish it in the Bao window, then press Continue.");
  assert.equal(quiet.proposed(), 0);

  const clutter = countingHeal();
  const clutterDriver = fake([
    tree([
      ident({ role: "heading", text: "This is a modal window" }),
      ident({ role: "button", text: "Close" }),
    ]),
    tree([ident({ testId: "apply", text: "Apply" })]),
  ]);
  const cleared = await replay(doc("https://shop.example/home", [clickApply]), {}, clutterDriver, { heal: clutter.heal });
  assert.equal(cleared.status, "passed");
  assert.equal(cleared.steps[0]?.reason, "recovered: clutter");
  assert.equal(cleared.pageClasses.at(-1)?.class, "clutter");
  assert.equal(cleared.heals.length, 0);
  assert.equal(cleared.modelCalls, 0);
  assert.equal(clutter.proposed(), 0);
  assert.deepEqual(clutterDriver.clicks, ["Close", "apply"]);

  const changed = countingHeal();
  const missed = await replay(
    doc("https://shop.example/home", [clickApply]),
    {},
    fake([tree([ident({ role: "button", text: "Somewhere else", testId: "other" })])]),
    { heal: changed.heal },
  );
  assert.equal(missed.pageClasses.at(-1)?.class, "changed");
  assert.equal(changed.proposed(), 1);
  assert.equal(missed.heals.length, 1);
  assert.equal(missed.modelCalls, 0);
});

test("the run page and the heals list show the class, the line, and zero calls", () => {
  const line = "Experian is showing a bot check. Finish it in the Bao window, then press Continue.";
  const ask = makeAsk({
    kind: "wall",
    wall: "bot",
    workflowId: "experian",
    workflowName: "Experian",
    stepId: "open",
    stepIndex: 1,
    stepCount: 1,
    label: "Open account",
    site: "usa.experian.com",
    timeoutMs: 0,
    runId: "run-wall",
  });
  assert.equal(ask.instruction, line);
  const bar = actBar({ activeAsk: ask }, 1_000);
  assert.match(bar, /id="act-bar"/);
  assert.match(bar, /id="act-continue"/);
  assert.match(bar, /Continue/);
  assert.match(bar, /Experian is showing a bot check/);
  const run: RunSummary = {
    id: "run-wall",
    workflowId: "experian",
    status: "needs_human",
    at: 1,
    heals: [],
    modelCalls: 0,
    steps: [{ id: "open", status: "paused", reason: "bot_wall", label: "Open account" }],
    envelope: { status: "needs_human", ask: line, reason: line, step: "open", run_id: "run-wall" },
    pageClasses: [{
      stepId: "open",
      class: "bot_wall",
      reason: "bot check",
      vendor: "Imperva",
      line,
      evidence: [{ source: "iframe", detail: "/_Incapsula_Resource" }],
    }],
  };
  const html = runViewer(run, { name: "Experian", steps: [{ id: "open", label: "Open account" }] });
  assert.match(html, /id="page-class"/);
  assert.match(html, /data-class="bot_wall"/);
  assert.match(html, /Bot check/);
  assert.match(html, /Imperva/);
  assert.match(html, /0 heals · 0 model calls/);
  assert.match(html, /needs_human/);
  const workflow: WorkflowSummary = { id: "experian", name: "Experian", steps: 1 };
  const inbox = healInbox([run], [workflow], "pending");
  assert.match(inbox, /data-page-class="bot_wall"/);
  assert.match(inbox, /Experian/);
  assert.match(inbox, /0 heals · 0 model calls/);
  assert.equal(inbox.includes("Nothing pending"), false);
});
