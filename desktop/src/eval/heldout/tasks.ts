// Held-out tasks. The keep flags are the intended steps, chosen with the task,
// before any condenser runs. Noise steps are the messy behavior around them.

export type Oracle =
  | { kind: "body"; includes: string }
  | { kind: "url"; includes: string }
  | { kind: "value"; selector: string; equals: string }
  | { kind: "checked"; selector: string }
  | { kind: "any-body"; includes: string };

export interface HeldStep {
  keep?: boolean;
  secret?: boolean;
  human?: "login" | "confirm";
  do: "read" | "scroll" | "back" | "click" | "type" | "backs" | "key" | "upload";
  op?: string;
  selector?: string;
  text?: string;
  key?: string;
  count?: number;
  file?: string;
}

export interface HeldTask {
  id: string;
  name: string;
  url: string;
  secret?: string;
  replays: { texts: string[]; secret: string; file: string }[];
  oracle: Oracle;
  steps: HeldStep[];
}

const READS: HeldStep[] = [
  { do: "read", op: "screenshot" },
  { do: "read", op: "move" },
  { do: "read", op: "ax" },
];

export const HELD_TASKS: HeldTask[] = [
  {
    id: "wiki-search",
    name: "Search Wikipedia",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    replays: [
      { texts: ["Grace Hopper"], secret: "", file: "" },
      { texts: ["Alan Turing"], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "a[href='/wiki/Talk:Main_Page'] >> visible=true" },
      { do: "read", op: "dom" },
      { do: "back" },
      { do: "scroll" },
      { do: "type", selector: "input[name='search'] >> visible=true", text: "Ada Lovelacex" },
      { do: "backs", selector: "input[name='search'] >> visible=true", count: 1 },
      { do: "type", selector: "input[name='search'] >> visible=true", text: "Ada Lovelace", keep: true },
      { do: "click", selector: "form#searchform button >> visible=true", keep: true },
    ],
  },
  {
    id: "w3c-form",
    name: "Fill the W3C label example",
    url: "https://www.w3.org/WAI/tutorials/forms/labels/",
    replays: [
      { texts: ["Grace"], secret: "", file: "" },
      { texts: ["Lin"], secret: "", file: "" },
    ],
    oracle: { kind: "value", selector: "#firstname", equals: "{{0}}" },
    steps: [
      ...READS,
      { do: "type", selector: "#header-search", text: "nope" },
      { do: "backs", selector: "#header-search", count: 4 },
      { do: "scroll" },
      { do: "type", selector: "#firstname", text: "Adx" },
      { do: "backs", selector: "#firstname", count: 1 },
      { do: "type", selector: "#firstname", text: "Ada", keep: true },
      { do: "click", selector: "#subscribe" },
      { do: "click", selector: "#subscribe", keep: true },
      { do: "read", op: "screenshot" },
    ],
  },
  {
    id: "mdn-form-link",
    name: "Open the MDN input element page",
    url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/form",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "url", includes: "/Elements/input" },
    steps: [
      ...READS,
      { do: "click", selector: "a[href='/en-US/docs/Web/HTML/Reference/Elements/dt'] >> visible=true" },
      { do: "read", op: "move" },
      { do: "back" },
      { do: "click", selector: "a[href='/en-US/docs/Web/HTML/Reference/Elements/input'] >> visible=true", keep: true },
    ],
  },
  {
    id: "login",
    name: "Log in on the-internet",
    url: "https://the-internet.herokuapp.com/login",
    secret: "HeldOutDemoSecret!",
    replays: [
      { texts: ["grace"], secret: "ReplaySecretOne!", file: "" },
      { texts: ["lin"], secret: "ReplaySecretTwo!", file: "" },
    ],
    oracle: { kind: "body", includes: "invalid" },
    steps: [
      ...READS,
      { do: "click", selector: "h2" },
      { do: "click", selector: "h2" },
      { do: "read", op: "dom" },
      { do: "type", selector: "#username", text: "tomsmithh" },
      { do: "backs", selector: "#username", count: 1 },
      { do: "type", selector: "#username", text: "tomsmith", keep: true },
      { do: "type", selector: "#password", text: "HeldOutDemoSecret!", secret: true, human: "login", keep: true },
      { do: "scroll" },
      { do: "click", selector: "button[type=submit]", human: "login", keep: true },
    ],
  },
  {
    id: "upload",
    name: "Upload a file on the-internet",
    url: "https://the-internet.herokuapp.com/upload",
    replays: [
      { texts: [], secret: "", file: "held-out-a.txt" },
      { texts: [], secret: "", file: "held-out-b.txt" },
    ],
    oracle: { kind: "body", includes: "{{file}}" },
    steps: [
      ...READS,
      { do: "click", selector: "#file-submit" },
      { do: "back" },
      { do: "click", selector: "h3" },
      { do: "click", selector: "h3" },
      { do: "upload", selector: "#file-upload", file: "held-out-note.txt", keep: true },
      { do: "click", selector: "#file-submit", keep: true },
    ],
  },
  {
    id: "dynamic-controls",
    name: "Remove a checkbox on the-internet",
    url: "https://the-internet.herokuapp.com/dynamic_controls",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "gone" },
    steps: [
      ...READS,
      { do: "click", selector: "#input-example button" },
      { do: "scroll" },
      { do: "click", selector: "#checkbox-example button", keep: true },
    ],
  },
  {
    id: "windows",
    name: "Open a new window on the-internet",
    url: "https://the-internet.herokuapp.com/windows",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "any-body", includes: "New Window" },
    steps: [
      ...READS,
      { do: "click", selector: "h3" },
      { do: "read", op: "move" },
      { do: "click", selector: "h3" },
      { do: "click", selector: "a[href='/windows/new']", keep: true },
    ],
  },
  {
    id: "inputs",
    name: "Type a number on the-internet",
    url: "https://the-internet.herokuapp.com/inputs",
    replays: [
      { texts: ["8"], secret: "", file: "" },
      { texts: ["3"], secret: "", file: "" },
    ],
    oracle: { kind: "value", selector: "input[type=number]", equals: "{{0}}" },
    steps: [
      ...READS,
      { do: "scroll" },
      { do: "type", selector: "input[type=number]", text: "42x" },
      { do: "backs", selector: "input[type=number]", count: 1 },
      { do: "type", selector: "input[type=number]", text: "42", keep: true },
    ],
  },
  {
    id: "forgot-password",
    name: "Request a password reset on the-internet",
    url: "https://the-internet.herokuapp.com/forgot_password",
    replays: [
      { texts: ["grace@example.com"], secret: "", file: "" },
      { texts: ["lin@example.com"], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "sent" },
    steps: [
      ...READS,
      { do: "click", selector: "h2" },
      { do: "click", selector: "h2" },
      { do: "scroll" },
      { do: "type", selector: "#email", text: "ada@example.comx" },
      { do: "backs", selector: "#email", count: 1 },
      { do: "type", selector: "#email", text: "ada@example.com", keep: true },
      { do: "click", selector: "#form_submit", keep: true },
    ],
  },
  {
    id: "add-element",
    name: "Add an element on the-internet",
    url: "https://the-internet.herokuapp.com/add_remove_elements/",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "Delete" },
    steps: [
      ...READS,
      { do: "click", selector: "button >> nth=0" },
      { do: "click", selector: ".added-manually" },
      { do: "scroll" },
      { do: "click", selector: "button >> nth=0", keep: true },
    ],
  },
  {
    id: "todo",
    name: "Add a todo on TodoMVC",
    url: "https://todomvc.com/examples/react/dist/",
    replays: [
      { texts: ["write tests"], secret: "", file: "" },
      { texts: ["ship replay"], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "{{0}}" },
    steps: [
      ...READS,
      { do: "click", selector: "h1" },
      { do: "scroll" },
      { do: "type", selector: "input.new-todo", text: "buy milkx" },
      { do: "backs", selector: "input.new-todo", count: 1 },
      { do: "type", selector: "input.new-todo", text: "buy milk", keep: true },
      { do: "key", key: "Enter", keep: true },
      { do: "click", selector: "a[href='#/completed'] >> visible=true" },
      { do: "click", selector: "a[href='#/'] >> visible=true" },
    ],
  },
  {
    id: "checkboxes",
    name: "Check a box on the-internet",
    url: "https://the-internet.herokuapp.com/checkboxes",
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "checked", selector: "form#checkboxes input >> nth=0" },
    steps: [
      ...READS,
      { do: "click", selector: "form#checkboxes input >> nth=1" },
      { do: "click", selector: "form#checkboxes input >> nth=1" },
      { do: "scroll" },
      { do: "click", selector: "form#checkboxes input >> nth=0", keep: true },
    ],
  },
];
