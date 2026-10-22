// Second held-out batch. Written after batch 1 was scored, for pages that
// batch did not use. Keep flags are the intended steps, chosen here, before
// this batch is condensed.

import type { HeldTask } from "./tasks";

const READS: HeldTask["steps"] = [
  { do: "read", op: "screenshot" },
  { do: "read", op: "move" },
  { do: "read", op: "ax" },
];

export const HELD_TASKS_2: HeldTask[] = [
  {
    id: "httpbin-order",
    name: "Submit an httpbin order",
    url: "https://httpbin.org/forms/post",
    replays: [
      { texts: ["Grace Hopper"], secret: "", file: "" },
      { texts: ["Lin"], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "input[name='size'] >> nth=0" },
      { do: "type", selector: "input[name='custname']", text: "Ada Lovelacex" },
      { do: "backs", selector: "input[name='custname']", count: 1 },
      { do: "type", selector: "input[name='custname']", text: "Ada Lovelace", keep: true },
      { do: "type", selector: "textarea[name='comments']", text: "nope" },
      { do: "backs", selector: "textarea[name='comments']", count: 4 },
      { do: "click", selector: "button", keep: true },
    ],
  },
  {
    id: "status-200",
    name: "Open the 200 status page",
    url: "https://the-internet.herokuapp.com/status_codes",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "returned a 200" },
    steps: [
      ...READS,
      { do: "click", selector: "a[href='status_codes/404']" },
      { do: "back" },
      { do: "click", selector: "h3" },
      { do: "click", selector: "h3" },
      { do: "click", selector: "a[href='status_codes/200']", keep: true },
    ],
  },
  {
    id: "redirect",
    name: "Follow the redirector",
    url: "https://the-internet.herokuapp.com/redirector",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "status_codes" },
    steps: [
      ...READS,
      { do: "click", selector: "h3" },
      { do: "click", selector: "h3" },
      { do: "click", selector: "#redirect", keep: true },
    ],
  },
  {
    id: "quotes-author",
    name: "Open an author on Quotes to Scrape",
    url: "https://quotes.toscrape.com/",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "/author/Albert-Einstein" },
    steps: [
      ...READS,
      { do: "click", selector: "a[href='/tag/deep-thoughts/page/1/']" },
      { do: "back" },
      { do: "click", selector: "h1" },
      { do: "click", selector: "a[href='/author/Albert-Einstein'] >> visible=true", keep: true },
    ],
  },
  {
    id: "quotes-tag",
    name: "Open a tag on Quotes to Scrape",
    url: "https://quotes.toscrape.com/",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "/tag/inspirational/" },
    steps: [
      ...READS,
      { do: "click", selector: "a[href='/login']" },
      { do: "back" },
      { do: "scroll" },
      { do: "click", selector: "a[href='/tag/inspirational/page/1/'] >> visible=true", keep: true },
    ],
  },
  {
    id: "quotes-login",
    name: "Log in on Quotes to Scrape",
    url: "https://quotes.toscrape.com/login",
    secret: "BatchTwoDemoSecret!",
    replays: [
      { texts: ["grace"], secret: "ReplaySecretA!", file: "" },
      { texts: ["lin"], secret: "ReplaySecretB!", file: "" },
    ],
    oracle: { kind: "body", includes: "Logout" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "type", selector: "#username", text: "adax" },
      { do: "backs", selector: "#username", count: 1 },
      { do: "type", selector: "#username", text: "ada", keep: true },
      { do: "type", selector: "#password", text: "BatchTwoDemoSecret!", secret: true, human: "login", keep: true },
      { do: "click", selector: "input[type=submit]", human: "login", keep: true },
    ],
  },
  {
    id: "books-travel",
    name: "Open Travel on Books to Scrape",
    url: "https://books.toscrape.com/",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "travel_2" },
    steps: [
      ...READS,
      { do: "click", selector: "a[href='catalogue/category/books/mystery_3/index.html']" },
      { do: "back" },
      { do: "click", selector: "a[href='catalogue/category/books/travel_2/index.html']", keep: true },
    ],
  },
  {
    id: "w3c-shipping",
    name: "Fill a W3C shipping name",
    url: "https://www.w3.org/WAI/tutorials/forms/grouping/",
    replays: [
      { texts: ["Grace"], secret: "", file: "" },
      { texts: ["Lin"], secret: "", file: "" },
    ],
    oracle: { kind: "value", selector: "#shipping_name", equals: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "#check_1" },
      { do: "type", selector: "#header-search", text: "nope" },
      { do: "backs", selector: "#header-search", count: 4 },
      { do: "type", selector: "#shipping_name", text: "Adx" },
      { do: "backs", selector: "#shipping_name", count: 1 },
      { do: "type", selector: "#shipping_name", text: "Ada", keep: true },
    ],
  },
  {
    id: "w3c-check",
    name: "Check a W3C newsletter box",
    url: "https://www.w3.org/WAI/tutorials/forms/grouping/",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "checked", selector: "#check_1" },
    steps: [
      ...READS,
      { do: "click", selector: "a[href='/WAI/test-evaluate/'] >> visible=true" },
      { do: "back" },
      { do: "click", selector: "#check_2" },
      { do: "click", selector: "#check_1", keep: true },
    ],
  },
  {
    id: "mdn-button",
    name: "Open the MDN forms guide from the button page",
    url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "/Extensions/Forms" },
    steps: [
      ...READS,
      { do: "click", selector: "a[href='/en-US/docs/Glossary/User_agent'] >> visible=true" },
      { do: "read", op: "move" },
      { do: "back" },
      { do: "click", selector: "h1" },
      { do: "click", selector: "a[href='/en-US/docs/Learn_web_development/Extensions/Forms'] >> visible=true", keep: true },
    ],
  },
  {
    id: "alerts",
    name: "Accept a JavaScript alert",
    url: "https://the-internet.herokuapp.com/javascript_alerts",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "successfully clicked an alert" },
    steps: [
      ...READS,
      { do: "click", selector: "h3" },
      { do: "click", selector: "h3" },
      { do: "click", selector: "text=Click for JS Confirm" },
      { do: "click", selector: "text=Click for JS Alert", keep: true },
    ],
  },
  {
    id: "playwright-todo",
    name: "Add a todo on the Playwright TodoMVC demo",
    url: "https://demo.playwright.dev/todomvc",
    replays: [
      { texts: ["write tests"], secret: "", file: "" },
      { texts: ["ship replay"], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "scroll" },
      { do: "type", selector: "input[placeholder='What needs to be done?']", text: "buy milkx" },
      { do: "backs", selector: "input[placeholder='What needs to be done?']", count: 1 },
      { do: "type", selector: "input[placeholder='What needs to be done?']", text: "buy milk", keep: true },
      { do: "key", key: "Enter", keep: true },
    ],
  },
];
