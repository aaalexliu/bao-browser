// Fourth held-out batch. Pages are not the ones used in batches 1, 2, or 3.
// Keep flags are the intended steps, chosen here, before this batch is condensed.

import type { HeldTask } from "./tasks";

const READS: HeldTask["steps"] = [
  { do: "read", op: "screenshot" },
  { do: "read", op: "move" },
  { do: "read", op: "ax" },
];

export const HELD_TASKS_4: HeldTask[] = [
  {
    id: "selenium-greeting",
    name: "Submit the Selenium web form",
    url: "https://www.selenium.dev/selenium/web/web-form.html",
    replays: [
      { texts: ["Paris"], secret: "", file: "" },
      { texts: ["Oslo"], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "type", selector: "#my-text-id", text: "Pariss" },
      { do: "backs", selector: "#my-text-id", count: 1 },
      { do: "type", selector: "#my-text-id", text: "Paris", keep: true },
      { do: "type", selector: "textarea[name='my-textarea']", text: "nope" },
      { do: "backs", selector: "textarea[name='my-textarea']", count: 4 },
      { do: "click", selector: "button[type=submit]", keep: true },
    ],
  },
  {
    id: "selenium-confirm",
    name: "Accept the Selenium confirm",
    url: "https://www.selenium.dev/selenium/web/alerts.html",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "simpleTest" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "click", selector: "h1" },
      { do: "click", selector: "#confirm", keep: true },
    ],
  },
  {
    id: "selenium-agree",
    name: "Check the Selenium agreement box",
    url: "https://www.selenium.dev/selenium/web/web-form.html",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "checked", selector: "#my-check-2" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "click", selector: "h1" },
      { do: "click", selector: "#my-check-2", keep: true },
    ],
  },
  {
    id: "hockey-search",
    name: "Search Scrape This Site for a team",
    url: "https://www.scrapethissite.com/pages/forms/",
    replays: [
      { texts: ["Boston"], secret: "", file: "" },
      { texts: ["Chicago"], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "type", selector: "#q", text: "Bostonn" },
      { do: "backs", selector: "#q", count: 1 },
      { do: "type", selector: "#q", text: "Boston", keep: true },
      { do: "click", selector: "input[type=submit]", keep: true },
    ],
  },
  {
    id: "caniuse-search",
    name: "Search Can I use",
    url: "https://caniuse.com/",
    replays: [
      { texts: ["grid"], secret: "", file: "" },
      { texts: ["flex"], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "h2" },
      { do: "type", selector: "#feat_search", text: "gridd" },
      { do: "backs", selector: "#feat_search", count: 1 },
      { do: "type", selector: "#feat_search", text: "grid", keep: true },
      { do: "key", key: "Enter", keep: true },
    ],
  },
  {
    id: "sauce-username",
    name: "Fill the Swag Labs login",
    url: "https://www.saucedemo.com/",
    secret: "secret_sauce",
    replays: [
      { texts: ["grace"], secret: "ReplayFourA!", file: "" },
      { texts: ["lin"], secret: "ReplayFourB!", file: "" },
    ],
    oracle: { kind: "value", selector: "#user-name", equals: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "h4" },
      { do: "type", selector: "#user-name", text: "standard_userx" },
      { do: "backs", selector: "#user-name", count: 1 },
      { do: "type", selector: "#user-name", text: "standard_user", keep: true },
      { do: "type", selector: "#password", text: "secret_sauce", secret: true, human: "login", keep: true },
    ],
  },
  {
    id: "globalsqa-search",
    name: "Search GlobalSQA",
    url: "https://www.globalsqa.com/samplepagetest/",
    replays: [
      { texts: ["tooltip"], secret: "", file: "" },
      { texts: ["datepicker"], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "type", selector: "#s", text: "tooltipp" },
      { do: "backs", selector: "#s", count: 1 },
      { do: "type", selector: "#s", text: "tooltip", keep: true },
      { do: "click", selector: "button.button_search", keep: true },
    ],
  },
  {
    id: "bulma-text",
    name: "Fill the Bulma text input",
    url: "https://bulma.io/documentation/form/general/",
    replays: [
      { texts: ["Cascade"], secret: "", file: "" },
      { texts: ["Column"], secret: "", file: "" },
    ],
    oracle: { kind: "value", selector: "input.input[placeholder='Text input']", equals: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "click", selector: "h1" },
      { do: "type", selector: "input.input[placeholder='Text input']", text: "Cascadex" },
      { do: "backs", selector: "input.input[placeholder='Text input']", count: 1 },
      { do: "type", selector: "input.input[placeholder='Text input']", text: "Cascade", keep: true },
    ],
  },
  {
    id: "parabank-username",
    name: "Fill the ParaBank login",
    url: "https://parabank.parasoft.com/parabank/index.htm",
    secret: "BatchFourDemoSecret!",
    replays: [
      { texts: ["grace"], secret: "ReplayFourC!", file: "" },
      { texts: ["lin"], secret: "ReplayFourD!", file: "" },
    ],
    oracle: { kind: "value", selector: "input[name='username']", equals: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "h2" },
      { do: "type", selector: "input[name='username']", text: "adax" },
      { do: "backs", selector: "input[name='username']", count: 1 },
      { do: "type", selector: "input[name='username']", text: "ada", keep: true },
      { do: "type", selector: "input[name='password']", text: "BatchFourDemoSecret!", secret: true, human: "login", keep: true },
    ],
  },
  {
    id: "webscraper-laptop",
    name: "Open a Web Scraper laptop",
    url: "https://webscraper.io/test-sites/e-commerce/allinone/computers/laptops",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "/product/" },
    steps: [
      ...READS,
      { do: "scroll" },
      { do: "click", selector: "h1" },
      { do: "click", selector: "a.title", keep: true },
    ],
  },
  {
    id: "htmx-edit",
    name: "Open the htmx click-to-edit form",
    url: "https://htmx.org/examples/click-to-edit/",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "value", selector: "#firstName", equals: "Joe" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "click", selector: "h1" },
      { do: "click", selector: "button", keep: true },
    ],
  },
  {
    id: "playwright-locators",
    name: "Open the Playwright locators page",
    url: "https://playwright.dev/docs/intro",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "/docs/locators" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "click", selector: "a[href='/docs/locators']", keep: true },
    ],
  },
];
