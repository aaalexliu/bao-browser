// Sixth held-out batch. Pages are not the ones used in batches 1 through 5.
// Keep flags are the intended steps, chosen here, before this batch is condensed.
// Throwaway Chrome profiles only. No login.

import type { HeldTask } from "./tasks";

const READS: HeldTask["steps"] = [
  { do: "read", op: "screenshot" },
  { do: "read", op: "move" },
  { do: "read", op: "ax" },
];

export const HELD_TASKS_6: HeldTask[] = [
  {
    id: "wiki-portal",
    name: "Search from the Wikipedia portal",
    url: "https://www.wikipedia.org/",
    replays: [
      { texts: ["Hopper"], secret: "", file: "" },
      { texts: ["Turing"], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "type", selector: "#searchInput", text: "Lovelacee" },
      { do: "backs", selector: "#searchInput", count: 1 },
      { do: "type", selector: "#searchInput", text: "Lovelace", keep: true },
      { do: "click", selector: "button[type=submit]", keep: true },
    ],
  },
  {
    id: "httpbin-links",
    name: "Open an httpbin link",
    url: "https://httpbin.org/links/10",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "/links/10/1" },
    steps: [
      ...READS,
      { do: "click", selector: "a[href='/links/10/2']" },
      { do: "back" },
      { do: "click", selector: "a[href='/links/10/1']", keep: true },
    ],
  },
  {
    id: "internet-keys",
    name: "Press a key on the-internet",
    url: "https://the-internet.herokuapp.com/key_presses",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "You entered: A" },
    steps: [
      ...READS,
      { do: "click", selector: "h3" },
      { do: "click", selector: "h3" },
      { do: "click", selector: "#target", keep: true },
      { do: "key", key: "A", keep: true },
    ],
  },
  {
    id: "internet-notify",
    name: "Load a new notification",
    url: "https://the-internet.herokuapp.com/notification_message_rendered",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "Action" },
    steps: [
      ...READS,
      { do: "click", selector: "h3" },
      { do: "click", selector: "a[href='/notification_message']", keep: true },
    ],
  },
  {
    id: "internet-loading",
    name: "Start the hidden Hello World",
    url: "https://the-internet.herokuapp.com/dynamic_loading/1",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "Hello World" },
    steps: [
      ...READS,
      { do: "click", selector: "h3" },
      { do: "click", selector: "button", keep: true },
    ],
  },
  {
    id: "mdn-input",
    name: "Open the MDN user-agent glossary from input",
    url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "/Glossary/User_agent" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "click", selector: "a[href='/en-US/docs/Glossary/User_agent']", keep: true },
    ],
  },
  {
    id: "mdn-structure",
    name: "Open the next MDN HTML lesson",
    url: "https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "Basic_HTML_syntax" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "click", selector: "a[href='/en-US/docs/Learn_web_development/Core/Structuring_content/Basic_HTML_syntax']", keep: true },
    ],
  },
  {
    id: "mdn-beacon",
    name: "Open the MDN Beacon API",
    url: "https://developer.mozilla.org/en-US/docs/Web/API",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "Beacon_API" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "click", selector: "a[href='/en-US/docs/Web/API/Beacon_API']", keep: true },
    ],
  },
  {
    id: "internet-float",
    name: "Open the floating News section",
    url: "https://the-internet.herokuapp.com/floating_menu",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "#news" },
    steps: [
      ...READS,
      { do: "click", selector: "h3" },
      { do: "click", selector: "a[href='#home']" },
      { do: "click", selector: "a[href='#news']", keep: true },
    ],
  },
  {
    id: "internet-dom",
    name: "Open an edit link in the challenging DOM",
    url: "https://the-internet.herokuapp.com/challenging_dom",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "#edit" },
    steps: [
      ...READS,
      { do: "click", selector: "h3" },
      { do: "click", selector: "a[href='#delete']" },
      { do: "click", selector: "a[href='#edit']", keep: true },
    ],
  },
];
