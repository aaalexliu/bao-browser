// Local fixture tasks for the driver eval. No public site is required.

export type PlanStep =
  | { tool: "screenshot" }
  | { tool: "snapshot" }
  | { tool: "click"; id: string }
  | { tool: "clickRef"; id: string }
  | { tool: "type"; text: string }
  | { tool: "upload"; id: string }
  | { tool: "scroll"; id: string; dy: number }
  | { tool: "key"; key: string };

export interface DriverTask {
  id: string;
  title: string;
  /** Query on the capture URL. Replay uses replayQuery. */
  captureQuery: string;
  replayQuery: string;
  plan: PlanStep[];
  /** Text input values for capture, then two replays. File names follow the same pattern. */
  captureTexts: string[];
  replayTexts: [string[], string[]];
  captureFile?: string;
  replayFiles?: [string, string];
  /** A password the capture driver tries to type. Live MCP must not write it down. */
  captureSecret?: string;
  replaySecrets?: [string, string];
  expectStop?: "login" | "confirm";
}

export const CAPTURE_SECRET = "CaptureOnlySecret!";

export const DRIVER_TASKS: DriverTask[] = [
  {
    id: "form-file",
    title: "Form with a typed name and a file",
    captureQuery: "",
    replayQuery: "",
    captureTexts: ["Ada"],
    replayTexts: [["Grace"], ["Lin"]],
    captureFile: "note-a.txt",
    replayFiles: ["note-b.txt", "note-c.txt"],
    plan: [
      { tool: "screenshot" },
      { tool: "snapshot" },
      { tool: "click", id: "name" },
      { tool: "type", text: "Ada" },
      { tool: "upload", id: "file" },
      { tool: "clickRef", id: "noop" },
      { tool: "click", id: "save" },
      { tool: "snapshot" },
    ],
  },
  {
    id: "tabs",
    title: "In-page tabs",
    captureQuery: "",
    replayQuery: "",
    captureTexts: ["Paris"],
    replayTexts: [["Lyon"], ["Nice"]],
    plan: [
      { tool: "screenshot" },
      { tool: "snapshot" },
      { tool: "click", id: "tab-address" },
      { tool: "snapshot" },
      { tool: "click", id: "city" },
      { tool: "type", text: "Paris" },
      { tool: "click", id: "tab-review" },
      { tool: "click", id: "finish" },
      { tool: "snapshot" },
    ],
  },
  {
    id: "login",
    title: "Login act-bar stop",
    captureQuery: "",
    replayQuery: "",
    captureTexts: ["ada"],
    replayTexts: [["grace"], ["lin"]],
    captureSecret: CAPTURE_SECRET,
    replaySecrets: ["ReplaySecretOne!", "ReplaySecretTwo!"],
    expectStop: "login",
    plan: [
      { tool: "screenshot" },
      { tool: "snapshot" },
      { tool: "click", id: "username" },
      { tool: "type", text: "ada" },
      { tool: "click", id: "password" },
      { tool: "type", text: CAPTURE_SECRET },
      { tool: "click", id: "login-btn" },
      { tool: "snapshot" },
    ],
  },
  {
    id: "confirm",
    title: "Confirm stop",
    captureQuery: "",
    replayQuery: "",
    captureTexts: ["old note"],
    replayTexts: [["new note"], ["other note"]],
    expectStop: "confirm",
    plan: [
      { tool: "screenshot" },
      { tool: "snapshot" },
      { tool: "click", id: "note" },
      { tool: "type", text: "old note" },
      { tool: "click", id: "delete" },
      { tool: "snapshot" },
      { tool: "click", id: "confirm" },
      { tool: "snapshot" },
    ],
  },
  {
    id: "drift",
    title: "Drifted layout",
    captureQuery: "shift=1",
    replayQuery: "",
    captureTexts: ["shifted"],
    replayTexts: [["plain"], ["again"]],
    plan: [
      { tool: "screenshot" },
      { tool: "snapshot" },
      { tool: "click", id: "note" },
      { tool: "type", text: "shifted" },
      { tool: "click", id: "save" },
      { tool: "snapshot" },
    ],
  },
  {
    id: "dialog",
    title: "Native-ish dialog stub",
    captureQuery: "",
    replayQuery: "",
    captureTexts: ["report.txt"],
    replayTexts: [["other.txt"], ["third.txt"]],
    plan: [
      { tool: "screenshot" },
      { tool: "snapshot" },
      { tool: "click", id: "browse" },
      { tool: "snapshot" },
      { tool: "click", id: "filename" },
      { tool: "type", text: "report.txt" },
      { tool: "click", id: "open" },
      { tool: "snapshot" },
    ],
  },
  {
    id: "scroll",
    title: "Scroll then pick a row",
    captureQuery: "",
    replayQuery: "",
    captureTexts: ["grace"],
    replayTexts: [["lin"], ["ada"]],
    plan: [
      { tool: "screenshot" },
      { tool: "snapshot" },
      { tool: "click", id: "filter" },
      { tool: "type", text: "grace" },
      { tool: "scroll", id: "list", dy: 700 },
      { tool: "snapshot" },
      { tool: "click", id: "row-30" },
      { tool: "snapshot" },
    ],
  },
  {
    id: "choice",
    title: "Choice and a label",
    captureQuery: "",
    replayQuery: "",
    captureTexts: ["west"],
    replayTexts: [["east"], ["north"]],
    plan: [
      { tool: "screenshot" },
      { tool: "snapshot" },
      { tool: "click", id: "blue" },
      { tool: "click", id: "label" },
      { tool: "type", text: "west" },
      { tool: "click", id: "apply" },
      { tool: "snapshot" },
    ],
  },
];

export function taskHtml(id: string): string | null {
  const bodies: Record<string, string> = {
    "form-file": `
      <h1>Form</h1>
      <label for="name">Name</label>
      <input id="name" name="name" data-testid="name">
      <label for="file">File</label>
      <input id="file" name="file" type="file" data-testid="file">
      <button id="noop" type="button" data-testid="noop">Noop</button>
      <button id="save" type="button" data-testid="save">Save</button>`,
    tabs: `
      <h1>Tabs</h1>
      <button id="tab-address" type="button" data-testid="tab-address">Address</button>
      <button id="tab-review" type="button" data-testid="tab-review">Review</button>
      <div id="panel-address" hidden>
        <label for="city">City</label>
        <input id="city" name="city" data-testid="city">
      </div>
      <div id="panel-review" hidden><p>Review the city, then finish.</p></div>
      <button id="finish" type="button" data-testid="finish">Finish</button>`,
    login: `
      <h1>Login</h1>
      <label for="username">Username</label>
      <input id="username" name="username" data-testid="username" autocomplete="username">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" data-testid="password" autocomplete="current-password">
      <button id="login-btn" type="button" data-testid="login-btn" data-bao-gate="login">Log in</button>`,
    confirm: `
      <h1>Delete</h1>
      <label for="note">Note</label>
      <input id="note" name="note" data-testid="note">
      <button id="delete" type="button" data-testid="delete">Delete</button>
      <div id="dialog" role="dialog" aria-label="Delete item" hidden>
        <p>Delete this item?</p>
        <button id="confirm" type="button" data-testid="confirm" data-bao-gate="confirm">Confirm</button>
      </div>`,
    drift: `
      <h1>Drift</h1>
      <label for="note">Note</label>
      <input id="note" name="note" data-testid="note">
      <button id="save" type="button" data-testid="save">Save</button>`,
    dialog: `
      <h1>Files</h1>
      <button id="browse" type="button" data-testid="browse">Browse</button>
      <div id="dialog" role="dialog" aria-label="Open file" hidden>
        <p>Name the file. This dialog is part of the page, not the operating system.</p>
        <label for="filename">Name</label>
        <input id="filename" name="filename" data-testid="filename">
        <button id="open" type="button" data-testid="open">Open</button>
      </div>`,
    scroll: `
      <h1>List</h1>
      <label for="filter">Filter</label>
      <input id="filter" name="filter" data-testid="filter">
      <div id="list" data-testid="list">${rowButtons()}</div>`,
    choice: `
      <h1>Color</h1>
      <label><input type="radio" id="blue" name="color" value="blue" data-testid="blue"> Blue</label>
      <label><input type="radio" id="red" name="color" value="red" data-testid="red"> Red</label>
      <label for="label">Label</label>
      <input id="label" name="label" data-testid="label">
      <button id="apply" type="button" data-testid="apply">Apply</button>`,
  };
  const body = bodies[id];
  if (!body) return null;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${id}</title>
  <style>
    body { font: 16px sans-serif; margin: 24px; background: #f6f4ef; color: #1c1915; }
    body.shift { margin-top: 220px; }
    label { display: block; margin: 8px 0 4px; }
    input, button { font: inherit; padding: 6px 8px; }
    #list { height: 120px; overflow: auto; border: 1px solid #8a8175; width: 240px; }
    #dialog { border: 2px solid #1c1915; padding: 12px; width: 280px; background: #fff; margin-top: 12px; }
    [hidden] { display: none !important; }
    #status, #flash, #files, #picked { font-weight: 600; }
  </style>
</head>
<body data-task="${id}">
  ${body}
  <p id="status" data-testid="status"></p>
  <p id="flash" data-testid="flash"></p>
  <p id="files" data-testid="files"></p>
  <p id="picked" data-testid="picked"></p>
  <script>
    if (new URLSearchParams(location.search).get("shift") === "1") document.body.classList.add("shift");
    const status = document.getElementById("status");
    const setStatus = (value) => { if (status) status.textContent = value; };
    const showFile = (file) => {
      const node = document.getElementById("files");
      if (node) node.textContent = file ? file.name : "";
    };
    document.getElementById("file")?.addEventListener("change", (event) => {
      showFile(event.target.files && event.target.files[0]);
    });
    document.getElementById("file")?.addEventListener("dragover", (event) => event.preventDefault());
    document.getElementById("file")?.addEventListener("drop", (event) => {
      event.preventDefault();
      showFile(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]);
    });
    document.getElementById("login-btn")?.addEventListener("click", () => {
      const user = document.getElementById("username");
      const pass = document.getElementById("password");
      const flash = document.getElementById("flash");
      if (!user || !pass || !user.value || !pass.value) {
        if (flash) flash.textContent = "Missing";
        return;
      }
      if (flash) flash.textContent = "Welcome " + user.value;
      history.pushState({}, "", "/secure");
    });
    document.body.addEventListener("click", (event) => {
      const el = event.target.closest("button, [id^='row-']");
      if (!el) return;
      const task = document.body.dataset.task;
      if (el.id === "tab-address" || el.id === "tab-review") {
        const address = document.getElementById("panel-address");
        const review = document.getElementById("panel-review");
        if (address) address.hidden = el.id !== "tab-address";
        if (review) review.hidden = el.id !== "tab-review";
      }
      if (el.id === "finish") {
        const city = document.getElementById("city");
        setStatus(city && city.value ? "Done" : "Missing");
      }
      if (el.id === "save" && task === "form-file") {
        const name = document.getElementById("name");
        const files = document.getElementById("files");
        setStatus(name && name.value && files && files.textContent ? "Saved" : "Missing");
      }
      if (el.id === "save" && task === "drift") {
        const note = document.getElementById("note");
        setStatus(note && note.value ? "Saved" : "Missing");
      }
      if (el.id === "delete") {
        const dialog = document.getElementById("dialog");
        if (dialog) dialog.hidden = false;
        setStatus("Armed");
      }
      if (el.id === "confirm") setStatus("Deleted");
      if (el.id === "browse") {
        const dialog = document.getElementById("dialog");
        if (dialog) dialog.hidden = false;
        setStatus("Dialog");
      }
      if (el.id === "open") {
        const filename = document.getElementById("filename");
        const picked = document.getElementById("picked");
        if (picked) picked.textContent = filename ? filename.value : "";
        setStatus("Chosen");
      }
      if (el.id && el.id.indexOf("row-") === 0) {
        const picked = document.getElementById("picked");
        if (picked) picked.textContent = el.textContent || "";
        setStatus("Picked");
      }
      if (el.id === "apply") {
        const picked = document.querySelector("input[name=color]:checked");
        setStatus(picked ? "Applied" : "Missing");
      }
    });
  </script>
</body>
</html>`;
}

function rowButtons(): string {
  const rows = [];
  for (let i = 1; i <= 40; i++) {
    rows.push(`<button id="row-${i}" type="button" data-testid="row-${i}">Row ${i}</button>`);
  }
  return rows.join("");
}

export interface FixtureView {
  url: string;
  status: string;
  flash: string;
  files: string;
  picked: string;
  nodes: {
    id: string;
    role: string;
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    vx?: number;
    vy?: number;
    vw?: number;
    vh?: number;
  }[];
}

export function captureOk(task: DriverTask, view: FixtureView, stops: string[]): string | null {
  if (task.expectStop && !stops.includes(task.expectStop)) return `expected STOP ${task.expectStop}`;
  if (task.id === "login") {
    if (view.flash.includes("Welcome") || view.url.includes("/secure")) return "login stop did not hold";
    return null;
  }
  if (task.id === "confirm") {
    if (view.status === "Deleted") return "confirm stop did not hold";
    if (view.status !== "Armed") return `status ${view.status || "empty"}`;
    return null;
  }
  const expect: Record<string, string> = {
    "form-file": "Saved",
    tabs: "Done",
    drift: "Saved",
    dialog: "Chosen",
    scroll: "Picked",
    choice: "Applied",
  };
  const status = expect[task.id];
  if (status && view.status !== status) return `status ${view.status || "empty"} wanted ${status}`;
  if (task.id === "form-file" && task.captureFile && !view.files.includes(task.captureFile)) return "file name missing";
  if (task.id === "dialog" && view.picked !== "report.txt") return `picked ${view.picked}`;
  if (task.id === "scroll" && view.picked !== "Row 30") return `picked ${view.picked}`;
  return null;
}
