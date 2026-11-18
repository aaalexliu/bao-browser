// The page class is decided before a heal. Each class is a fixture, and a
// wall stops the run with no heal and no model call.

import assert from "node:assert/strict";
import test from "node:test";
import { judgeSignedIn } from "../../src/login-import/probe";
import { classifyPage, siteName, type PageSignals } from "../../src/v1/page-class";

test("a vendor challenge is a bot wall and a plain 200 is not", () => {
  const cases: { vendor: string; signals: PageSignals }[] = [
    { vendor: "reCAPTCHA", signals: { iframeSrcs: ["https://www.google.com/recaptcha/api2/anchor"], texts: ["I'm not a robot"] } },
    { vendor: "hCaptcha", signals: { markers: ["h-captcha"], widgets: [{ src: "https://newassets.hcaptcha.com/captcha", w: 304, h: 78 }] } },
    { vendor: "Turnstile", signals: { markers: ["cf-turnstile"], widgets: [{ src: "https://challenges.cloudflare.com/turnstile", w: 300, h: 65 }] } },
    { vendor: "Cloudflare", signals: { title: "Just a moment...", texts: ["Checking your browser before accessing the site"] } },
    { vendor: "Akamai", signals: { title: "Access Denied", texts: ["Reference #18.6f4a"], markers: ["akamai"] } },
    { vendor: "Imperva", signals: { iframeSrcs: ["/_Incapsula_Resource"], texts: ["Incapsula incident ID: 123"] } },
    { vendor: "PerimeterX", signals: { markers: ["px-captcha"], texts: ["Press & Hold"] } },
    { vendor: "DataDome", signals: { markers: ["datadome"], widgets: [{ src: "https://geo.captcha-delivery.com/captcha", w: 300, h: 150 }] } },
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
  assert.equal(classifyPage({
    iframeSrcs: ["https://www.google.com/recaptcha/api2/aframe"],
    widgets: [{ src: "https://www.google.com/recaptcha/api2/aframe", w: 0, h: 0 }],
    texts: ["Web Tables", "Add"],
    targetPresent: true,
  }).class, "changed");
  assert.equal(classifyPage({
    iframeSrcs: ["https://www.google.com/recaptcha/api2/aframe"],
    texts: ["Web Tables"],
  }).class, "changed");
  assert.equal(classifyPage({
    title: "Just a moment...",
    texts: ["Checking your browser before accessing the site"],
    targetPresent: true,
  }).class, "changed");
  const widget = classifyPage({
    widgets: [{ src: "https://www.google.com/recaptcha/api2/anchor", w: 304, h: 78 }],
    texts: ["I'm not a robot"],
    targetPresent: false,
  });
  assert.equal(widget.class, "bot_wall");
  assert.equal(widget.vendor, "reCAPTCHA");
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
  const form = classifyPage({
    texts: ["Registration Form"],
    nodes: [
      { role: "dialog", text: "Registration Form" },
      { role: "button", text: "Close" },
      { role: "textbox", id: "firstName", name: "First Name" },
    ],
    targetPresent: true,
  });
  assert.equal(form.class, "changed");
});
