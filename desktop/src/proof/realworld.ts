// Real-world proof. Records once through bao's page recorder and replays
// twice through bao's replayer. This file does not change replay behavior.
//
//   npm run proof:realworld
//   PROOF_TASKS=p2,p6 npm run proof:realworld

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startApp } from "../app/server";
import type { WorkflowStep, WorkflowV2 } from "../v1/schema";
import { pauseIsExpected, scoreBotWall, type TaskExpect } from "./task-expect";

process.env.BAO_DRIVE = "1";
process.env.BAO_PROOF_PAGE = "1";
process.env.BAO_CHROME_NO_SANDBOX = process.env.BAO_CHROME_NO_SANDBOX || "1";

const ROOT = path.resolve("docs/proof/realworld");
const ARTIFACTS = path.join(ROOT, "artifacts");
const PUBLIC_ARTIFACTS = "/opt/cursor/artifacts/proof-realworld";
const ONLY = (process.env.PROOF_TASKS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface PageView {
  open?: boolean;
  url?: string;
  title?: string;
  text?: string;
  pathname?: string;
  status?: string;
}

interface HealView {
  id?: string;
  model?: { name?: string; provider?: string };
  postconditionPassed?: boolean;
  failedStep?: { id?: string; label?: string; action?: string };
  proposedPatch?: unknown;
}

interface RunView {
  runId?: string;
  status?: string;
  modelCalls?: number;
  pausedKind?: string;
  heals?: HealView[];
  fileProof?: { action?: string; name?: string; via?: string }[];
  failure?: { stepId?: string; phase?: string; reason?: string; snapshot?: { ax?: string; dom?: { text?: string; name?: string }[] } };
  steps?: { id: string; status: string; reason?: string; phase?: string; snapshot?: { ax?: string; dom?: { text?: string; name?: string }[] } }[];
  ask?: { kind?: string; instruction?: string };
  bounds?: { width?: number; height?: number };
  outputs?: { name?: string; type?: string; rows?: Record<string, string>[] }[];
}

interface ReplayScore {
  pass: boolean;
  status: string;
  modelCalls: number;
  heals: string[];
  cause: string;
  detail: string;
  failedStep: string;
}

interface TaskResult {
  id: string;
  title: string;
  site: string;
  pass: string;
  modelCalls: string;
  heals: string;
  firstFailure: string;
  cause: string;
  replays: ReplayScore[];
  recorded: Record<string, unknown>;
  artifacts: string[];
  note: string;
}

type DriveBody = Record<string, unknown>;

interface ExtractProposal {
  mode?: string;
  count?: number;
  error?: string;
  columns: { id: string; name: string; read: string; samples?: string[] }[];
}

class Session {
  constructor(private port: number) {}

  async open(url: string): Promise<void> {
    await call(this.port, "POST", "/api/sessions", { url });
    await sleep(600);
  }

  async view(): Promise<PageView> {
    return call(this.port, "GET", "/api/sessions/page") as Promise<PageView>;
  }

  async drive(body: DriveBody): Promise<void> {
    await call(this.port, "POST", "/api/sessions/drive", { timeout: 12000, ...body });
    await sleep(350);
  }

  async proposeExtract(selector: string): Promise<ExtractProposal> {
    return call(this.port, "POST", "/api/sessions/extract/propose", { selector }) as Promise<ExtractProposal>;
  }

  async commitExtract(body: { names: Record<string, string>; drop: string[]; maxPages: number; as: string; vary: string }): Promise<void> {
    await call(this.port, "POST", "/api/sessions/extract/commit", body);
  }

  async waitFor(needle: string, ms = 15000): Promise<PageView> {
    const start = Date.now();
    let last: PageView = {};
    while (Date.now() - start < ms) {
      last = await this.view().catch(() => ({}));
      const hay = `${last.url || ""} ${last.title || ""} ${last.text || ""}`;
      if (hay.toLowerCase().includes(needle.toLowerCase())) return last;
      await sleep(300);
    }
    throw new Error(`timed out waiting for "${needle}" at ${last.url || "?"} — ${(last.text || "").slice(0, 180)}`);
  }

  async stop(): Promise<WorkflowV2> {
    return call(this.port, "POST", "/api/sessions/stop") as Promise<WorkflowV2>;
  }

  /** A gesture the recorder may not be able to see. Keep recording the rest of the task. */
  async attempt(body: DriveBody, label: string): Promise<void> {
    try {
      await this.drive(body);
    } catch (err) {
      console.log(`step ${label}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async discard(): Promise<void> {
    await call(this.port, "POST", "/api/sessions/discard").catch(() => undefined);
  }
}

async function main(): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  mkdirSync(PUBLIC_ARTIFACTS, { recursive: true });
  mkdirSync(path.join(ROOT, "workflows"), { recursive: true });
  mkdirSync(path.join(ROOT, "runs"), { recursive: true });
  const home = path.join(tmpdir(), `bao-proof-${Date.now().toString(36)}`);
  const app = await startApp({ home, port: 0 });
  const results: TaskResult[] = [];
  writeTasks();
  try {
    for (const task of TASKS) {
      if (ONLY.length && !ONLY.includes(task.id)) continue;
      console.log(`\n=== ${task.id} ${task.title} ===`);
      const result = await runTask(app.port, home, task).catch((err): TaskResult => ({
        id: task.id,
        title: task.title,
        site: task.site,
        pass: "0/2",
        modelCalls: "0, 0",
        heals: "0, 0",
        firstFailure: err instanceof Error ? err.message : String(err),
        cause: "record failed",
        replays: [],
        recorded: {},
        artifacts: [],
        note: "the task threw before a replay score was written",
      }));
      results.push(result);
      writeResults(results);
      console.log(`${task.id} ${result.pass} ${result.firstFailure}`);
    }
  } finally {
    writeResults(results);
    await app.close();
  }
}

interface Task {
  id: string;
  title: string;
  site: string;
  mac?: boolean;
  openUrl?: string;
  expect: TaskExpect;
  record?: (session: Session, files: RunFiles) => Promise<void>;
  args: (workflow: WorkflowV2, run: 1 | 2, files: RunFiles) => Record<string, unknown>;
  score: (input: ScoreInput) => { pass: boolean; cause: string; detail: string };
  layout?: (workflow: WorkflowV2) => string | undefined;
}

interface RunFiles {
  recordFile: string;
  replayFile: [string, string];
  recordImage: string;
  replayImage: [string, string];
}

interface ScoreInput {
  run: 1 | 2;
  replay: RunView;
  page: PageView;
  workflow: WorkflowV2;
  args: Record<string, unknown>;
  files: RunFiles;
  openUrl: string;
  csv?: string;
  expect: TaskExpect;
}

const TASKS: Task[] = [
  {
    id: "p1",
    title: "Sign-up, contact upload, delete account",
    site: "automationexercise.com",
    openUrl: "https://automationexercise.com/login",
    expect: "completed",
    record: recordP1,
    args: (workflow, run, files) => argsFor(workflow, {
      secret: run === 1 ? "BaoProof-replay-a-9" : "BaoProof-replay-b-9",
      file: { name: path.basename(files.replayFile[run - 1]!), path: files.replayFile[run - 1]! },
      byDefault: p1Defaults(workflow, run),
      byName: run === 1
        ? { days: "12", months: "3", years: "1992" }
        : { days: "21", months: "11", years: "1988" },
    }),
    score: scoreP1,
  },
  {
    id: "p2",
    title: "Practice form with date picker and dependent selects",
    site: "demoqa.com",
    openUrl: "https://demoqa.com/automation-practice-form",
    expect: "completed",
    record: recordP2,
    args: (workflow, run, files) => argsFor(workflow, {
      file: { name: path.basename(files.replayImage[run - 1]!), path: files.replayImage[run - 1]! },
      byDefault: run === 1 ? P2_A : P2_B,
      byName: run === 1
        ? { dateOfBirthInput: "1991-03-18", dateOfBirth: "1991-03-18" }
        : { dateOfBirthInput: "1984-11-04", dateOfBirth: "1984-11-04" },
    }),
    score: scoreP2,
  },
  {
    id: "p3",
    title: "Booking, stop before reserve",
    site: "automationintesting.online",
    openUrl: "https://automationintesting.online/",
    expect: "needs_human",
    record: recordP3,
    args: (workflow, run) => argsFor(workflow, { byDefault: run === 1 ? P3_A : P3_B }),
    score: scoreP3,
  },
  {
    id: "p4",
    title: "Trial search and CSV download",
    site: "clinicaltrials.gov",
    openUrl: "https://clinicaltrials.gov/search",
    expect: "completed",
    record: recordP4,
    args: (workflow, run) => argsFor(workflow, { byDefault: run === 1 ? P4_A : P4_B }),
    score: scoreP4,
  },
  {
    id: "p5",
    title: "Paginated catalog to CSV",
    site: "books.toscrape.com",
    openUrl: "https://books.toscrape.com/",
    expect: "completed",
    record: recordP5,
    args: (workflow, run) => argsFor(workflow, {
      byName: { category: run === 1 ? "Travel" : "Historical Fiction" },
    }),
    score: scoreP5,
  },
  {
    id: "p6",
    title: "Spreadsheet rows into a web table",
    site: "demoqa.com/webtables",
    openUrl: "https://demoqa.com/webtables",
    expect: "completed",
    record: recordP6,
    args: (workflow, run) => argsFor(workflow, { byDefault: run === 1 ? P6_A : P6_B }),
    score: scoreP6,
  },
  {
    id: "p7",
    title: "Wikipedia history across skins",
    site: "en.wikipedia.org",
    openUrl: "https://en.wikipedia.org/wiki/Special:Search",
    expect: "completed",
    record: recordP7,
    args: (workflow, run) => argsFor(workflow, { byDefault: run === 1 ? { Baozi: "Baozi" } : { Baozi: "Xiaolongbao" } }),
    score: scoreP7,
    layout: (workflow) => withSkin(workflow.startUrl, "vector"),
  },
  {
    id: "p8",
    title: "Unstable DOM, new tab, JS dialogs",
    site: "the-internet.herokuapp.com",
    openUrl: "https://the-internet.herokuapp.com/challenging_dom",
    expect: "completed",
    record: recordP8,
    args: (workflow, run) => argsFor(workflow, {
      byDefault: run === 1
        ? { "row-two": "row-two", "proof-prompt": "alpha-prompt" }
        : { "row-four": "row-four", "proof-prompt": "beta-prompt" },
    }),
    score: scoreP8,
  },
  {
    id: "p9",
    title: "Shadow-DOM shop, stop before place order",
    site: "shop.polymer-project.org",
    openUrl: "https://shop.polymer-project.org/",
    expect: "needs_human",
    record: recordP9,
    args: (workflow, run) => argsFor(workflow, {
      byDefault: run === 1 ? P9_A : P9_B,
    }),
    score: scoreP9,
  },
  {
    id: "p10",
    title: "TextEdit",
    site: "TextEdit",
    mac: true,
    expect: "completed",
    args: () => ({}),
    score: () => ({ pass: false, cause: "needs Mac", detail: "needs Mac" }),
  },
  {
    id: "p11",
    title: "W-9 download and Preview",
    site: "irs.gov + Preview",
    mac: true,
    expect: "completed",
    args: () => ({}),
    score: () => ({ pass: false, cause: "needs Mac", detail: "needs Mac" }),
  },
  {
    id: "p12",
    title: "CSV into Numbers",
    site: "Numbers",
    mac: true,
    expect: "completed",
    args: () => ({}),
    score: () => ({ pass: false, cause: "needs Mac", detail: "needs Mac" }),
  },
  {
    id: "p13",
    title: "Excalidraw canvas",
    site: "excalidraw.com",
    openUrl: "https://excalidraw.com/",
    expect: "completed",
    record: recordP13,
    args: (workflow, run) => argsFor(workflow, { byDefault: run === 1 ? { Alpha: "Alpha", Beta: "Beta" } : { Gamma: "Gamma", Delta: "Delta" } }),
    score: scoreP13,
  },
  {
    id: "p14",
    title: "Bot wall",
    site: "practicesoftwaretesting.com",
    openUrl: "https://practicesoftwaretesting.com/",
    expect: "needs_human",
    record: recordP14,
    args: (workflow) => argsFor(workflow, {}),
    score: scoreP14,
  },
];

function p1Defaults(workflow: WorkflowV2, run: 1 | 2): Record<string, string> {
  const defaults = { ...(run === 1 ? P1_A : P1_B) };
  const recorded = workflow.inputs.map((input) => input.default).find((value) => !!value && value.includes("@"));
  if (recorded) defaults[recorded] = recorded.replace("bao-record-", run === 1 ? "bao-alpha-" : "bao-beta-");
  return defaults;
}

const P1_A: Record<string, string> = {
  "Bao Record": "Bao Alpha",
  "bao-record@example.com": "bao-alpha@example.com",
  "Hello from the proof record.": "Hello from replay alpha.",
  Canada: "United States",
  "1990": "1992",
};
const P1_B: Record<string, string> = {
  "Bao Record": "Bao Beta",
  "bao-record@example.com": "bao-beta@example.com",
  "Hello from the proof record.": "Hello from replay beta.",
  Canada: "India",
  "1990": "1988",
};
const P2_A: Record<string, string> = {
  Ada: "Grace",
  Lovelace: "Hopper",
  "9990001111": "9990002222",
  "1 Market Street": "2 Navy Yard",
  Maths: "Physics",
  NCR: "Haryana",
  Delhi: "Karnal",
};
const P2_B: Record<string, string> = {
  Ada: "Radia",
  Lovelace: "Perlman",
  "9990001111": "9990003333",
  "1 Market Street": "3 Packet Lane",
  Maths: "Chemistry",
  NCR: "Uttar Pradesh",
  Delhi: "Agra",
};
const P3_A: Record<string, string> = { "Bao Guest": "Ada Guest", "bao-guest@example.com": "ada-guest@example.com", "5550001111": "5550002222" };
const P3_B: Record<string, string> = { "Bao Guest": "Grace Guest", "bao-guest@example.com": "grace-guest@example.com", "5550001111": "5550003333" };
const P4_A: Record<string, string> = { "type 1 diabetes": "type 1 diabetes", California: "California" };
const P4_B: Record<string, string> = { "type 1 diabetes": "migraine", California: "Texas" };
const P6_A = peopleMap([
  ["Ada", "Alan"],
  ["Lovelace", "Turing"],
  ["ada-table@example.com", "alan-table@example.com"],
  ["Grace", "Edsger"],
  ["Hopper", "Dijkstra"],
  ["grace-table@example.com", "edsger-table@example.com"],
  ["Radia", "Barbara"],
  ["Perlman", "Liskov"],
  ["radia-table@example.com", "barbara-table@example.com"],
]);
const P6_B = peopleMap([
  ["Ada", "Ken"],
  ["Lovelace", "Thompson"],
  ["ada-table@example.com", "ken-table@example.com"],
  ["Grace", "Dennis"],
  ["Hopper", "Ritchie"],
  ["grace-table@example.com", "dennis-table@example.com"],
  ["Radia", "Frances"],
  ["Perlman", "Allen"],
  ["radia-table@example.com", "frances-table@example.com"],
]);
const P9_A: Record<string, string> = { Bao: "Ada", "1 Market": "2 Market", "San Francisco": "New York", "94105": "10001" };
const P9_B: Record<string, string> = { Bao: "Grace", "1 Market": "3 Market", "San Francisco": "Boston", "94105": "02139" };

function peopleMap(pairs: [string, string][]): Record<string, string> {
  return Object.fromEntries(pairs);
}

async function recordP1(session: Session, files: RunFiles): Promise<void> {
  const email = `bao-record-${Date.now().toString(36)}@example.com`;
  await session.open("https://automationexercise.com/login");
  await session.waitFor("New User Signup");
  await session.drive({ fill: { selector: "input[data-qa=signup-name]", value: "Bao Record" } });
  await session.drive({ fill: { selector: "input[data-qa=signup-email]", value: email } });
  await session.drive({ click: "button[data-qa=signup-button]" });
  await session.waitFor("Enter Account Information");
  await session.drive({ click: "label[for=id_gender1]" });
  await session.drive({ fill: { selector: "#password", value: "BaoProof-record-9" } });
  await session.drive({ select: { selector: "#days", value: "10" } });
  await session.drive({ select: { selector: "#months", label: "January" } });
  await session.drive({ select: { selector: "#years", value: "1990" } });
  await session.drive({ fill: { selector: "#first_name", value: "Bao" } });
  await session.drive({ fill: { selector: "#last_name", value: "Record" } });
  await session.drive({ fill: { selector: "#address1", value: "1 Proof Street" } });
  await session.drive({ select: { selector: "#country", label: "Canada" } });
  await session.drive({ fill: { selector: "#state", value: "Ontario" } });
  await session.drive({ fill: { selector: "#city", value: "Toronto" } });
  await session.drive({ fill: { selector: "#zipcode", value: "M5V1A1" } });
  await session.drive({ fill: { selector: "#mobile_number", value: "5550100000" } });
  await session.drive({ scroll: "#first_name" });
  await session.drive({ click: "button[data-qa=create-account]" });
  await session.waitFor("ACCOUNT CREATED");
  await session.drive({ click: "a[data-qa=continue-button]" });
  let home = await session.view();
  if (!/logged in as/i.test(`${home.title} ${home.text}`)) {
    await session.drive({ goto: "https://automationexercise.com/" });
    home = await session.view();
  }
  if (!/logged in as/i.test(`${home.title} ${home.text}`)) {
    throw new Error(`account was created but the session was not logged in at ${home.url}`);
  }
  await session.drive({ click: "a[href='/contact_us']" });
  await session.waitFor("Get In Touch");
  await session.drive({ fill: { selector: "input[data-qa=name]", value: "Bao Record" } });
  await session.drive({ fill: { selector: "input[data-qa=email]", value: email } });
  await session.drive({ fill: { selector: "input[data-qa=subject]", value: "Proof note" } });
  await session.drive({ fill: { selector: "textarea[data-qa=message]", value: "Hello from the proof record." } });
  await session.drive({ upload: { selector: "input[name=upload_file]", path: files.recordFile } });
  await session.drive({ click: "input[data-qa=submit-button]" });
  await session.waitFor("submitted successfully");
  await session.drive({ click: "a[href='/delete_account']" });
  await session.waitFor("ACCOUNT DELETED");
}

async function recordP2(session: Session, files: RunFiles): Promise<void> {
  await session.open("https://demoqa.com/automation-practice-form");
  await session.waitFor("Student Registration Form");
  await session.drive({ fill: { selector: "#firstName", value: "Ada" } });
  await session.drive({ fill: { selector: "#lastName", value: "Lovelace" } });
  await session.drive({ fill: { selector: "#userEmail", value: "ada-form@example.com" } });
  await session.drive({ click: "label[for=gender-radio-1]" });
  await session.drive({ fill: { selector: "#userNumber", value: "9990001111" } });
  await session.drive({ click: "#dateOfBirthInput" });
  await session.drive({ select: { selector: ".react-datepicker__month-select", label: "January" } });
  await session.drive({ select: { selector: ".react-datepicker__year-select", value: "1990" } });
  await sleep(200);
  await session.drive({ click: ".react-datepicker__day--015:not(.react-datepicker__day--outside-month)" });
  // Enter submits the form when the suggestion list is closed. Click the option.
  await session.drive({ fill: { selector: "#subjectsInput", value: "Maths", keys: true } });
  await sleep(400);
  await session.drive({ click: "#react-select-2-option-0" });
  await session.drive({ click: "label[for=hobbies-checkbox-1]" });
  await session.drive({ upload: { selector: "#uploadPicture", path: files.recordImage } });
  await session.drive({ fill: { selector: "#currentAddress", value: "1 Market Street" } });
  await session.drive({ scroll: "#state" });
  // Enter submits the form. Typing opens the menu; the option click chooses it.
  await session.drive({ fill: { selector: "#react-select-3-input", value: "NCR", keys: true } });
  await sleep(400);
  await session.drive({ click: "#react-select-3-option-0" });
  await sleep(300);
  await session.drive({ scroll: "#city" });
  await session.drive({ fill: { selector: "#react-select-4-input", value: "Delhi", keys: true } });
  await sleep(400);
  await session.drive({ click: "#react-select-4-option-0" });
  await session.drive({ click: "#submit" });
  await session.waitFor("Thanks for submitting the form");
}

async function recordP3(session: Session): Promise<void> {
  await session.open("https://automationintesting.online/");
  await session.waitFor("Shady Meadows");
  await session.drive({ click: "a[href*='/reservation/1']" });
  await session.waitFor("Reserve Now");
  await session.drive({ click: "button:text-is('Next')" });
  await sleep(400);
  // Day-number clicks do not select a stay. A drag across the cells does.
  // On this calendar the highlighted cells are the nights: 05 through 06 is 2.
  await session.drive({
    drag: {
      from: ".rbc-month-view .rbc-date-cell:not(.rbc-off-range) button:text-is('05')",
      to: ".rbc-month-view .rbc-date-cell:not(.rbc-off-range) button:text-is('06')",
    },
  });
  await sleep(400);
  const view = await session.view();
  if (/First ?name/i.test(view.text || "")) {
    await session.drive({ fill: { selector: "#name", value: "Bao Guest" } });
    await session.drive({ fill: { selector: "#email", value: "bao-guest@example.com" } });
    await session.drive({ fill: { selector: "#phone", value: "5550001111" } });
  }
  await session.drive({ click: "#doReservation, button:text-is('Reserve Now')" });
}

async function recordP4(session: Session): Promise<void> {
  await session.open("https://clinicaltrials.gov/search");
  await session.waitFor("clinicaltrials.gov");
  await session.drive({ fill: { selector: "#advcond", value: "type 1 diabetes" }, press: "Enter" });
  await sleep(800);
  await session.drive({ fill: { selector: "#location-input", value: "California", keys: true } });
  await sleep(900);
  // The first suggestion is Current Location. Choose the typed place.
  await session.drive({ click: ".usa-combo-box__list-option >> text=\"California\"" });
  await sleep(400);
  // More Filters starts expanded. Clicking it closes the panel.
  // Keystrokes are what the date picker and Apply button listen for.
  await session.drive({
    fill: { selector: ".usa-date-picker:has(#adv-date-start-from) .usa-date-picker__external-input", value: "01/15/2020", keys: true },
    press: "Tab",
  });
  await session.drive({
    fill: { selector: ".usa-date-picker:has(#adv-date-start-to) .usa-date-picker__external-input", value: "12/31/2024", keys: true },
    press: "Tab",
  });
  await session.drive({ scroll: "#adv-check0-status1" });
  await session.drive({ click: "label[for='adv-check0-status1']" });
  await session.drive({ click: "#apply-filters" });
  await sleep(3000);
  const view = await session.view();
  const count = lastCount(view.text || "");
  if (count == null || count > 2000) {
    throw new Error(`refusing the download; result count was ${count ?? "unread"} (limit 2000)`);
  }
  await session.drive({ click: "#action-bar-download-btn" });
  await session.drive({ click: "label[for='download-format-csv']" });
  await session.drive({ click: "button.primary-button:text-is('Download')" });
  await sleep(2500);
}

async function recordP5(session: Session): Promise<void> {
  await session.open("https://books.toscrape.com/");
  await session.waitFor("Books to Scrape");
  await session.drive({ click: "a[href*='mystery_']" });
  await session.waitFor("mystery");
  const proposal = await session.proposeExtract("article.product_pod");
  if (proposal.mode !== "list" || (proposal.count || 0) < 2) {
    throw new Error(`extract did not see a book list (${proposal.error || proposal.mode || "empty"})`);
  }
  const names: Record<string, string> = {};
  const drop: string[] = [];
  for (const column of proposal.columns) {
    const sample = (column.samples || []).join(" ");
    if (column.read === "title" || column.name === "title") names[column.id] = "title";
    else if (column.read === "rating" || column.name === "rating" || /^(One|Two|Three|Four|Five)$/.test(column.samples?.[0] || "")) names[column.id] = "rating";
    else if (/£\d/.test(sample) || column.name.includes("price")) names[column.id] = "price";
    else drop.push(column.id);
  }
  const got = Object.values(names).sort().join(",");
  if (got !== "price,rating,title") throw new Error(`extract columns were ${got || "none"}`);
  await session.commitExtract({ names, drop, maxPages: 3, as: "books", vary: "category" });
}

async function recordP6(session: Session): Promise<void> {
  await session.open("https://demoqa.com/webtables");
  await session.waitFor("Web Tables");
  const people = [
    ["Ada", "Lovelace", "ada-table@example.com", "36", "10001", "Math"],
    ["Grace", "Hopper", "grace-table@example.com", "41", "10002", "Compilers"],
    ["Radia", "Perlman", "radia-table@example.com", "44", "10003", "Networks"],
    ["Donald", "Knuth", "donald-table@example.com", "84", "10004", "Algorithms"],
    ["Margaret", "Hamilton", "margaret-table@example.com", "89", "10005", "Apollo"],
  ];
  for (const [first, last, email, age, salary, dept] of people) {
    await session.drive({ click: "#addNewRecordButton" });
    await session.waitFor("Registration Form", 8000);
    await session.drive({ fill: { selector: "#firstName", value: first! } });
    await session.drive({ fill: { selector: "#lastName", value: last! } });
    await session.drive({ fill: { selector: "#userEmail", value: email! } });
    await session.drive({ fill: { selector: "#age", value: age! } });
    await session.drive({ fill: { selector: "#salary", value: salary! } });
    await session.drive({ fill: { selector: "#department", value: dept! } });
    await session.drive({ click: "#submit" });
    await sleep(400);
  }
}

async function recordP7(session: Session): Promise<void> {
  await sleep(5000);
  await session.open("https://en.wikipedia.org/wiki/Special:Search");
  const first = await session.view();
  if (/too many requests|429/i.test(`${first.title} ${first.text}`)) {
    throw new Error("Wikipedia returned 429 too many requests. Replays were not started.");
  }
  await session.waitFor("Search");
  await session.drive({ fill: { selector: "input[name=search]", value: "Baozi" }, press: "Enter" });
  await session.waitFor("Baozi");
  const view = await session.view();
  if (/too many requests|429/i.test(`${view.title} ${view.text}`)) {
    throw new Error("Wikipedia returned 429 too many requests. Replays were not started.");
  }
  await session.drive({ click: "a:text-is('View history'), #ca-history a, a[href*='action=history']" });
  await session.waitFor("Revision history");
}

async function recordP8(session: Session): Promise<void> {
  await session.open("https://the-internet.herokuapp.com/challenging_dom");
  await session.waitFor("Challenging DOM");
  await session.attempt({ click: "table tbody tr:nth-child(2) a[href='#edit']" }, "edit row");
  await session.drive({ goto: "https://the-internet.herokuapp.com/shifting_content/menu?mode=random" });
  await session.waitFor("Shifting Content");
  await session.attempt({ click: "a:text-is('Gallery')" }, "gallery");
  await session.drive({ goto: "https://the-internet.herokuapp.com/windows" });
  await session.waitFor("Opening a new window");
  await session.attempt({ click: "a:text-is('Click Here')" }, "new window");
  await session.drive({ goto: "https://the-internet.herokuapp.com/javascript_alerts" });
  await session.waitFor("JavaScript Alerts");
  await session.attempt({ click: "button:text-is('Click for JS Alert')" }, "alert");
  await session.attempt({ click: "button:text-is('Click for JS Confirm')" }, "confirm");
  await session.drive({ click: "button:text-is('Click for JS Prompt')", prompt: "proof-prompt" });
  await sleep(400);
}

async function recordP9(session: Session): Promise<void> {
  await session.open("https://shop.polymer-project.org/");
  await session.waitFor("Men's T-Shirts");
  await session.drive({ goto: "https://shop.polymer-project.org/list/mens_tshirts" });
  await session.waitFor("YouTube Organic Cotton");
  await session.drive({ click: "shop-app >> a[href*='YouTube+Organic']" });
  await session.waitFor("Add to Cart");
  await session.drive({ select: { selector: "shop-app >> #sizeSelect", label: "M" } });
  await session.drive({ select: { selector: "shop-app >> #quantitySelect", label: "2" } });
  await session.drive({ click: "shop-app >> shop-detail >> button:has-text('Add to Cart')" });
  await session.waitFor("View Cart");
  await session.drive({ click: "shop-app >> #viewCartAnchor" });
  await session.waitFor("Your Cart");
  await session.drive({ click: "shop-app >> shop-cart >> text=Checkout" });
  await session.waitFor("Account Information");
  await session.drive({ fill: { selector: "shop-app >> #accountEmail", value: "bao-buyer@example.com" } });
  await session.drive({ fill: { selector: "shop-app >> #accountPhone", value: "4155550199" } });
  await session.drive({ fill: { selector: "shop-app >> #shipAddress", value: "1 Market" } });
  await session.drive({ fill: { selector: "shop-app >> #shipCity", value: "San Francisco" } });
  await session.drive({ fill: { selector: "shop-app >> #shipState", value: "CA" } });
  await session.drive({ fill: { selector: "shop-app >> #shipZip", value: "94105" } });
  await session.drive({ fill: { selector: "shop-app >> #ccName", value: "Bao" } });
  await session.drive({ click: "shop-app >> shop-checkout >> input[value='Place Order']" });
}

async function recordP13(session: Session): Promise<void> {
  await session.open("https://excalidraw.com/");
  await session.waitFor("Excalidraw");
  await session.drive({ click: "button:text-is('Rectangle')" });
  await session.drive({ click: "canvas" }).catch(() => undefined);
  await session.drive({ click: "button:text-is('Text')" });
  await session.drive({ click: "canvas.excalidraw__canvas, canvas" }).catch(() => undefined);
  await session.drive({ press: "A" });
  await session.drive({ press: "l" });
  await session.drive({ press: "p" });
  await session.drive({ press: "h" });
  await session.drive({ press: "a" });
  await session.drive({ click: "button:text-is('Arrow')" });
  await session.drive({ click: "canvas" }).catch(() => undefined);
  await session.drive({ click: "button[aria-label='Menu'], button[aria-label='Main menu']" }).catch(() => undefined);
}

async function recordP14(session: Session): Promise<void> {
  await session.open("https://practicesoftwaretesting.com/");
  await sleep(4000);
  const view = await session.view();
  const bot = /cloudflare|turnstile|verifying you are not a bot|security verification|captcha/i.test(`${view.title} ${view.text}`);
  if (!bot) {
    throw new Error(`bot wall was not shown. title=${view.title || "?"} text=${(view.text || "").slice(0, 180)}`);
  }
}

async function runTask(port: number, home: string, task: Task): Promise<TaskResult> {
  if (task.mac || !task.record || !task.openUrl) {
    return {
      id: task.id,
      title: task.title,
      site: task.site,
      pass: "needs Mac",
      modelCalls: "—",
      heals: "—",
      firstFailure: "needs Mac",
      cause: "",
      replays: [],
      recorded: { skipped: "computer-use task; this host is Linux" },
      artifacts: [],
      note: "TextEdit, Preview, and Numbers are computer-use tasks and were not run.",
    };
  }
  const files = makeFiles(task.id);
  const session = new Session(port);
  let workflow: WorkflowV2 | undefined;
  let recordError = "";
  if (process.env.PROOF_REPLAY_ONLY === "1") {
    const saved = path.join(ROOT, "workflows", `${task.id}.json`);
    workflow = JSON.parse(readFileSync(saved, "utf8")) as WorkflowV2;
    await call(port, "POST", "/api/workflows/import", workflow);
  } else {
    try {
      await task.record(session, files);
    } catch (err) {
      recordError = err instanceof Error ? err.message : String(err);
      console.log(`record error: ${recordError}`);
    }
    try {
      workflow = await session.stop();
    } catch (err) {
      await session.discard();
      if (!recordError) recordError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!workflow) {
    return {
      id: task.id,
      title: task.title,
      site: task.site,
      pass: "0/2",
      modelCalls: "0, 0",
      heals: "0, 0",
      firstFailure: recordError || "recording produced no workflow",
      cause: /429|too many requests/i.test(recordError) ? "site blocked" : /iframe|intercepts pointer|frame/i.test(recordError) ? "iframe" : "record failed",
      replays: [],
      recorded: { openUrl: task.openUrl, recordError },
      artifacts: [],
      note: recordError,
    };
  }
  const recorded = summarizeWorkflow(workflow, task.openUrl, recordError);
  workflow = dropVolatileExpects(workflow);
  // stop() already stored the workflow. Replay reads that copy, so the
  // stripped expects have to be imported before the runs start.
  try {
    await call(port, "POST", "/api/workflows/import", workflow);
  } catch (err) {
    console.log(`import: ${err instanceof Error ? err.message : err}`);
  }
  writeFileSync(path.join(ROOT, "workflows", `${task.id}.json`), `${JSON.stringify(redact(workflow), null, 2)}\n`);
  if (/429|too many requests/i.test(recordError) || /429|too many requests/i.test(workflow.startUrl)) {
    return {
      id: task.id,
      title: task.title,
      site: task.site,
      pass: "0/2",
      modelCalls: "0, 0",
      heals: "0, 0",
      firstFailure: recordError || "Wikipedia returned 429",
      cause: "site blocked",
      replays: [],
      recorded,
      artifacts: [],
      note: "Replays were not started after a 429.",
    };
  }
  const replays: ReplayScore[] = [];
  const artifacts: string[] = [];
  let current: WorkflowV2 = workflow;
  for (const run of [1, 2] as const) {
    if (task.id === "p3" && run === 2) {
      const shifted = shiftBookingNights(current);
      if (shifted) {
        try {
          await call(port, "POST", "/api/workflows/import", shifted);
          current = shifted;
        } catch (err) {
          console.log(`nights: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    if (run === 2 && task.layout) {
      const next = task.layout(current);
      if (next && next !== current.startUrl) {
        const steps = current.steps.map((step, index) => {
          if (index === 0 && step.action === "navigate") return { ...step, value: next };
          // Legacy Vector's Enter submits fulltext. The same key on the current skin opens the article.
          // Go is the control that still opens it.
          if (task.id === "p7" && step.action === "key" && /^enter$/i.test(step.key || "")) return vectorGo(step);
          return step;
        });
        const updated: WorkflowV2 = { ...current, startUrl: next, steps };
        try {
          await call(port, "POST", "/api/workflows/import", updated);
          current = updated;
        } catch (err) {
          console.log(`layout: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    if (run === 2) {
      await call(port, "POST", "/api/replay/place", {
        id: current.id,
        x: 30,
        y: 30,
        width: task.id === "p7" ? 480 : 1100,
        height: task.id === "p7" ? 820 : 700,
      }).catch((err) => console.log(`place: ${err instanceof Error ? err.message : err}`));
    }
    const args = task.args(current, run, files);
    const started = Date.now();
    let replay: RunView;
    try {
      // Run 2 gets its own browser. The shared window was still the right run,
      // but its end page can be pixel-identical to run 1.
      replay = sanitizeRun(await call(port, "POST", "/api/replay", { id: current.id, args, fresh: run === 2 }) as RunView);
      if (task.id === "p9") {
        await call(port, "POST", "/api/replay/place", {
          id: current.id,
          x: 30,
          y: 30,
          width: 1100,
          height: 1000,
        }).catch((err) => console.log(`place: ${err instanceof Error ? err.message : err}`));
      }
    } catch (err) {
      replays.push({
        pass: false,
        status: "error",
        modelCalls: 0,
        heals: [],
        cause: "record failed",
        detail: err instanceof Error ? err.message : String(err),
        failedStep: "",
      });
      continue;
    }
    const page = await call(port, "GET", `/api/replay/page?id=${encodeURIComponent(current.id)}`).catch(() => ({})) as PageView;
    let csv = "";
    if (task.id === "p5" && replay.runId) {
      const got = await call(port, "GET", `/api/runs/${encodeURIComponent(replay.runId)}/outputs.csv?name=books`).catch(() => "");
      csv = typeof got === "string" ? got : "";
    }
    const shot = await saveShot(port, home, current.id, task.id, run, task.id === "p9" ? { width: 1280, height: 1000 } : undefined);
    if (shot) artifacts.push(shot);
    const identitySrc = replay.runId ? path.join(home, "shots", "runs", replay.runId, "identity.png") : "";
    const identity = identitySrc && existsSync(identitySrc) ? publish(identitySrc, `${task.id}-r${run}-identity.png`) : undefined;
    if (identity) artifacts.push(identity);
    const shotFile = path.join(ARTIFACTS, `${task.id}-r${run}.png`);
    const otherFile = path.join(ARTIFACTS, `${task.id}-r${run === 1 ? 2 : 1}.png`);
    const shotSha = existsSync(shotFile) ? createHash("sha256").update(readFileSync(shotFile)).digest("hex") : "";
    const samePixels = !!shotSha && existsSync(otherFile) && createHash("sha256").update(readFileSync(otherFile)).digest("hex") === shotSha;
    if (samePixels) console.log(`  replay ${run} end shot matches the other run pixel for pixel`);
    const frames = copyFrames(home, replay.runId, task.id, run);
    artifacts.push(...frames);
    const judged = judge(task, { run, replay, page, workflow: current, args, files, openUrl: task.openUrl, csv, expect: task.expect }, started);
    if (!judged.pass && replay.status === "passed") replay.status = "failed";
    judged.status = replay.status || judged.status;
    const endFrames = [shot, ...frames].filter((item): item is string => !!item);
    const reel = writeReel(task.id, run, endFrames);
    if (reel) artifacts.push(reel);
    writeFileSync(path.join(ROOT, "runs", `${task.id}-r${run}.json`), `${JSON.stringify({ args: publicArgs(args), replay, page: { url: page.url, title: page.title, text: (page.text || "").slice(0, 2500) }, downloaded: newCsvs(started), shot: { sha256: shotSha, samePixels, identity: identity || "" } }, null, 2)}\n`);
    replays.push(judged);
    console.log(`  replay ${run}: ${judged.pass ? "pass" : "fail"} model=${judged.modelCalls} heals=${judged.heals.length} ${judged.detail}`);
  }
  const passed = replays.filter((item) => item.pass).length;
  const first = replays.find((item) => !item.pass);
  return {
    id: task.id,
    title: task.title,
    site: task.site,
    pass: `${passed}/2`,
    modelCalls: replays.map((item) => String(item.modelCalls)).join(", ") || "0, 0",
    heals: replays.map((item) => item.heals.length ? item.heals.join(" | ") : "0").join(" ; ") || "0, 0",
    firstFailure: first ? first.detail : "",
    cause: first?.cause || "",
    replays,
    recorded,
    artifacts,
    note: recordError ? `Recording error before stop: ${recordError}` : "",
  };
}

function judge(task: Task, input: ScoreInput, started: number): ReplayScore {
  // A needs_human pause is the outcome. replayStopped would otherwise report
  // the bot wall, and a confirm gate, as a failed replay.
  const failure = pauseIsExpected(input.expect, input.replay)
    ? null
    : replayStopped(input.replay, input.workflow, input.openUrl, input.page);
  const check = task.score(input);
  const extra = task.id === "p4" ? scoreDownload(input.page, started) : null;
  const modelCalls = input.replay.modelCalls || 0;
  const heals = (input.replay.heals || []).map(healWhy);
  let pass = check.pass && modelCalls === 0 && !failure;
  let cause = "";
  let detail = check.detail;
  if (modelCalls > 0) {
    pass = false;
    cause = cause || "model call";
    detail = `${modelCalls} model call(s). ${detail}`;
  }
  if (failure) {
    pass = false;
    cause = failure.cause;
    detail = failure.detail;
  } else if (!check.pass) {
    pass = false;
    cause = check.cause || "pass check";
    detail = check.detail;
  }
  if (extra && !extra.pass) {
    pass = false;
    if (!failure) {
      cause = extra.cause;
      detail = extra.detail;
    }
  } else if (extra?.pass && pass) {
    detail = extra.detail;
  }
  const failed = (input.replay.steps || []).find((step) => step.status === "failed" || step.status === "paused");
  const wf = input.workflow.steps.find((step) => step.id === failed?.id);
  const status = !pass && (input.replay.status === "passed" || !input.replay.status)
    ? "failed"
    : (input.replay.status || "");
  return {
    pass,
    status,
    modelCalls,
    heals,
    cause,
    detail,
    failedStep: wf ? `${wf.id} ${wf.action} ${wf.label}` : failed?.id || "",
  };
}

function replayStopped(run: RunView, workflow: WorkflowV2, openUrl: string, page: PageView): { cause: string; detail: string } | null {
  if (run.status === "passed") return null;
  if (run.status === "paused" && run.pausedKind === "confirm") return null;
  const step = (run.steps || []).find((item) => item.status === "failed" || item.status === "paused");
  const wf = workflow.steps.find((item) => item.id === step?.id);
  const reason = run.failure?.reason || step?.reason || run.status || "stopped";
  const phase = run.failure?.phase || step?.phase || "";
  const label = wf ? `${wf.action} "${wf.label}"` : step?.id || "run";
  const detail = `${label}: ${phase} ${reason}`.replace(/\s+/g, " ").trim();
  const hay = `${reason} ${label} ${page.title || ""} ${(page.text || "").slice(0, 400)}`;
  if (/captcha|turnstile|cloudflare|not a bot|verify you are human|security verification/i.test(hay)) {
    return { cause: "bot wall", detail };
  }
  if (/iframe|frame was detached|intercepts pointer|googlesyndication/i.test(hay)) return { cause: "iframe", detail };
  const first = workflow.steps[0]?.id;
  if (step && first && step.id === first && hostPath(workflow.startUrl) !== hostPath(openUrl)) {
    return {
      cause: "missing step type",
      detail: `no open step; replay started at the stop URL ${workflow.startUrl} instead of ${openUrl}. ${detail}`,
    };
  }
  if (/shadow/i.test(hay)) return { cause: "shadow DOM", detail };
  if (/dialog|alert|prompt/i.test(`${label} ${reason}`)) return { cause: "dialog", detail };
  if (/new window|new tab/i.test(`${label} ${reason}`)) return { cause: "new tab", detail };
  if (/download/i.test(`${label} ${reason}`)) return { cause: "download", detail };
  if (/date|calendar/i.test(`${label} ${reason}`)) return { cause: "date picker", detail };
  return { cause: phase === "find" ? "lookup miss" : phase || "replay failed", detail };
}

function scoreP1(input: ScoreInput): { pass: boolean; cause: string; detail: string } {
  const text = evidence(input);
  const name = String(input.args.name || input.args.username || findArg(input.args, /Bao|name/i) || "");
  const file = fileName(input.args);
  const want = [
    "ACCOUNT CREATED!",
    name ? `Logged in as ${name}` : "Logged in as",
    "Success! Your details have been submitted successfully.",
    "ACCOUNT DELETED!",
  ];
  const missing = want.filter((item) => item && !text.includes(item));
  const fileOk = !file || text.includes(file) || (input.replay.fileProof || []).some((item) => item.name === file);
  if (!fileOk) missing.push(`uploaded file ${file}`);
  if (missing.length) return { pass: false, cause: "pass check", detail: `missing ${missing.join("; ")}` };
  return { pass: true, cause: "", detail: "account created, contact submitted, account deleted, file name matched" };
}

function scoreP2(input: ScoreInput): { pass: boolean; cause: string; detail: string } {
  const text = evidence(input);
  if (!/Thanks for submitting the form/i.test(text)) {
    return { pass: false, cause: "pass check", detail: "the thanks modal was not in the replay evidence" };
  }
  const values = Object.values(input.args).filter((item): item is string => typeof item === "string" && item.length > 1);
  const missing = values.filter((item) => !dateForms(item).some((form) => text.includes(form)));
  const dob = dobIn(text);
  if (!dob) missing.push("DOB dd Month,yyyy");
  if (missing.length) return { pass: false, cause: missing.some((item) => /DOB|January|March|November/.test(item)) ? "date picker" : "pass check", detail: `modal missed ${missing.join("; ")}` };
  return { pass: true, cause: "", detail: `modal matched inputs including ${dob}` };
}

function scoreP3(input: ScoreInput): { pass: boolean; cause: string; detail: string } {
  const nights = input.run === 1 ? 2 : 3;
  const text = evidence(input);
  const summary = text.match(/[£$](\d+)\s*x\s*(\d+)\s*nights?\s*[£$](\d+)([\s\S]*?)\bTotal\s*[£$](\d+)/i);
  const confirm = input.workflow.steps.some((step) => step.action === "confirm");
  const pressed = input.workflow.steps.some((step) => step.action === "click" && /reserve now/i.test(step.label));
  const halted = input.replay.status === "paused" && (input.replay.pausedKind === "confirm" || confirm);
  if (!summary) return { pass: false, cause: "date picker", detail: `summary did not show ${nights} nights` };
  const rate = Number(summary[1]);
  const gotNights = Number(summary[2]);
  const room = Number(summary[3]);
  const fees = [...(summary[4] || "").matchAll(/[£$](\d+)/g)].reduce((sum, item) => sum + Number(item[1]), 0);
  const gotTotal = Number(summary[5]);
  if (gotNights !== nights) return { pass: false, cause: "date picker", detail: `summary showed ${gotNights} nights, wanted ${nights}` };
  if (room !== nights * rate) return { pass: false, cause: "pass check", detail: `room ${room} !== ${nights} × ${rate}` };
  if (gotTotal !== room + fees) return { pass: false, cause: "pass check", detail: `total ${gotTotal} !== room ${room} + fees ${fees}` };
  if (pressed || !halted) return { pass: false, cause: "missing step type", detail: pressed ? "Reserve Now was a click, not a confirm gate" : "replay did not halt on a confirm gate" };
  return { pass: true, cause: "", detail: `${nights} nights, total ${gotTotal}, halted before Reserve Now` };
}

function scoreP4(input: ScoreInput): { pass: boolean; cause: string; detail: string } {
  return { pass: true, cause: "", detail: "download checked separately" };
}

function scoreDownload(page: PageView, started: number): { pass: boolean; cause: string; detail: string } {
  const files = newCsvs(started);
  const count = lastCount(page.text || "");
  const file = newestCsv(files);
  if (!file) return { pass: false, cause: "download", detail: "no CSV landed in Downloads or the replay profile" };
  const parsed = parseCsv(readFileSync(file, "utf8"));
  const statusCol = parsed.headers.findIndex((header) => /study status|^status$/i.test(header));
  const statuses = statusCol >= 0 ? parsed.rows.map((row) => (row[statusCol] || "").trim()) : [];
  const allRecruiting = statuses.length > 0 && statuses.every((item) => item.toUpperCase() === "RECRUITING");
  if (count == null) return { pass: false, cause: "download", detail: `CSV ${parsed.rows.length} rows at ${file}; the page count was unread` };
  if (parsed.rows.length !== count) return { pass: false, cause: "download", detail: `CSV rows ${parsed.rows.length} !== page count ${count}` };
  if (!allRecruiting) return { pass: false, cause: "download", detail: `CSV statuses were not all RECRUITING (${statuses.slice(0, 4).join(", ")})` };
  return { pass: true, cause: "", detail: `${parsed.rows.length} RECRUITING rows matched the page count` };
}

function scoreP5(input: ScoreInput): { pass: boolean; cause: string; detail: string } {
  const category = input.run === 1 ? "Travel" : "Historical Fiction";
  const extract = input.workflow.steps.find((step) => step.action === "extract");
  const declared = input.workflow.outputs?.some((item) => item.name === "books");
  if (!extract || !declared) {
    return { pass: false, cause: "missing step type", detail: "no extract or CSV output; category is a click, not an input" };
  }
  if (input.args.category !== category) {
    return { pass: false, cause: "pass check", detail: `replay category was ${String(input.args.category || "empty")}, wanted ${category}` };
  }
  const pageText = `${input.page.title || ""} ${input.page.text || ""} ${input.page.url || ""}`;
  if (!new RegExp(category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(pageText)) {
    return { pass: false, cause: "pass check", detail: `${category} was not the page that was scraped` };
  }
  const shown = Number((input.page.text || "").match(/(\d+)\s+results/i)?.[1] || "0");
  const table = (input.replay.outputs || []).find((item) => item.type === "table" && (item.name === "books" || item.rows));
  const rows = table?.rows || [];
  if (!shown || rows.length !== shown) {
    return { pass: false, cause: "pass check", detail: `CSV rows ${rows.length} !== site count ${shown || "unread"}` };
  }
  const csv = input.csv || "";
  const csvRows = csv.trim() ? csv.trim().split(/\n/).length - 1 : 0;
  if (csvRows !== shown) {
    return { pass: false, cause: "pass check", detail: `CSV file has ${csvRows} rows; the site showed ${shown}` };
  }
  const header = csv.split(/\n/)[0] || "";
  const missingCols = ["title", "price", "rating"].filter((name) => !new RegExp(`\\b${name}\\b`).test(header));
  if (missingCols.length || !/£/.test(csv)) {
    return { pass: false, cause: "pass check", detail: `CSV header missed ${missingCols.join(", ") || "a price"}` };
  }
  const prices = [...new Set([...(input.page.text || "").matchAll(/£\d+\.\d{2}/g)].map((item) => item[0]))];
  const missingPrices = prices.filter((price) => !csv.includes(price));
  if (!prices.length || missingPrices.length) {
    return { pass: false, cause: "pass check", detail: missingPrices.length ? `CSV missed page prices ${missingPrices.slice(0, 4).join(", ")}` : "the page showed no prices" };
  }
  const titled = rows.filter((row) => {
    const title = row.title || "";
    return title.length > 3 && (input.page.text || "").includes(title.slice(0, Math.min(12, title.length)));
  });
  if (!titled.length) {
    return { pass: false, cause: "pass check", detail: "CSV titles were not on the category page" };
  }
  return { pass: true, cause: "", detail: `${shown} ${category} rows matched the site, with a books CSV` };
}

function scoreP6(input: ScoreInput): { pass: boolean; cause: string; detail: string } {
  const wanted = input.run === 1
    ? ["Alan Turing", "Edsger Dijkstra", "Barbara Liskov"]
    : ["Ken Thompson", "Dennis Ritchie", "Frances Allen", "Donald Knuth", "Margaret Hamilton"];
  // Earlier snapshots repeat rows that are still on the page. The final table is the check.
  const text = input.page.text || "";
  const missing = wanted.filter((name) => !text.includes(name));
  const dupes = wanted.filter((name) => occurrences(text, name) > 1);
  if (input.run === 2 && input.workflow.steps.filter((step) => /add/i.test(step.label)).length < 5 && missing.length) {
    return { pass: false, cause: "missing step type", detail: `no for-each; table missed ${missing.join(", ")}` };
  }
  if (missing.length || dupes.length) return { pass: false, cause: "pass check", detail: `missing ${missing.join(", ") || "none"}; duplicates ${dupes.join(", ") || "none"}` };
  return { pass: true, cause: "", detail: `table showed ${wanted.join(", ")} once each` };
}

function scoreP7(input: ScoreInput): { pass: boolean; cause: string; detail: string } {
  const title = input.run === 1 ? "Baozi" : "Xiaolongbao";
  const text = evidence(input);
  if (/too many requests|429/i.test(text)) return { pass: false, cause: "site blocked", detail: "Wikipedia returned 429" };
  const stamp = text.match(/(\d{1,2}:\d{2}, \d{1,2} \w+ \d{4})/);
  const user = text.match(/Latest revision[\s\S]{0,80}?([A-Za-z0-9 ._'-]{2,40})/);
  if (!/Revision history|View history/i.test(text)) {
    return { pass: false, cause: "pass check", detail: `history page for ${title} was not in the replay evidence` };
  }
  if (input.run === 2 && !/useskin=vector/i.test(`${input.workflow.startUrl} ${input.page.url || ""}`)) {
    return { pass: false, cause: "pass check", detail: "legacy Vector skin was not applied on replay 2" };
  }
  if (!stamp) return { pass: false, cause: "missing step type", detail: "no revision timestamp was on the history page" };
  if (!new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) {
    return { pass: false, cause: "pass check", detail: `history page did not name ${title}` };
  }
  return { pass: true, cause: "", detail: `history page for ${title} showed revision ${stamp[1]}${user ? ` near ${user[1]}` : ""}` };
}

function scoreP8(input: ScoreInput): { pass: boolean; cause: string; detail: string } {
  const text = evidence(input);
  const prompt = input.run === 1 ? "alpha-prompt" : "beta-prompt";
  const dialog = input.workflow.steps.some((step) => /dialog|alert|prompt|confirm/i.test(`${step.label} ${JSON.stringify(step).slice(0, 200)}`));
  const entered = text.includes(`You entered: ${prompt}`) || text.includes(prompt);
  const heading = /New Window/i.test(text);
  if (!entered || !heading) {
    const cause = !dialog ? "dialog" : !heading ? "new tab" : "dialog";
    return { pass: false, cause, detail: `prompt ${entered ? "seen" : "missing"} (${prompt}); new window heading ${heading ? "seen" : "missing"}; dialog step ${dialog ? "recorded" : "not recorded"}` };
  }
  return { pass: true, cause: "", detail: "prompt text and New Window heading were both read" };
}

function scoreP9(input: ScoreInput): { pass: boolean; cause: string; detail: string } {
  if (input.expect !== "needs_human") {
    return { pass: false, cause: "missing step type", detail: "Place Order is scored as needs_human" };
  }
  const text = evidence(input);
  const pressed = input.workflow.steps.some((step) => step.action === "click" && /place order/i.test(step.label));
  const confirm = input.workflow.steps.some((step) => step.action === "confirm" && step.confirm === true && /place order/i.test(`${step.label} ${step.identity?.name || ""} ${step.identity?.text || ""}`));
  const shadow = input.workflow.steps.some((step) => /shop-app/i.test(JSON.stringify(step.identity || {})));
  if (pressed) return { pass: false, cause: "missing step type", detail: "Place Order was clicked" };
  if (!confirm) return { pass: false, cause: shadow ? "shadow DOM" : "missing step type", detail: shadow ? "clicks landed on the shadow host and there is no confirm gate" : "no confirm gate before Place Order" };
  if (!/YouTube Organic Cotton/i.test(text) || !/\$29\.50/.test(text)) {
    return { pass: false, cause: "shadow DOM", detail: "the cart did not show the YouTube shirt at $29.50" };
  }
  if (input.replay.status !== "paused" || input.replay.pausedKind !== "confirm") {
    return { pass: false, cause: "missing step type", detail: `replay status was ${input.replay.status || "empty"} / ${input.replay.pausedKind || "no pause"}` };
  }
  const ask = input.replay.ask?.instruction || "";
  if (!/place order/i.test(ask) || !/needs you/i.test(text)) {
    return { pass: false, cause: "missing step type", detail: "the pause did not show needs you at Place Order" };
  }
  const ship = input.run === 1 ? "2 Market" : "3 Market";
  if (!text.includes(ship)) return { pass: false, cause: "pass check", detail: `the replay address was not ${ship}` };
  return { pass: true, cause: "", detail: `cart total $29.50 and the run paused at Place Order (${ship})` };
}

function scoreP13(input: ScoreInput): { pass: boolean; cause: string; detail: string } {
  const labels = input.run === 1 ? ["Alpha", "Beta"] : ["Gamma", "Delta"];
  const text = evidence(input);
  const canvasClicks = input.workflow.steps.filter((step) => /canvas/i.test(JSON.stringify(step.identity || {}))).length;
  if (!/excalidraw/i.test(text) && canvasClicks === 0) {
    return { pass: false, cause: "missing step type", detail: "canvas clicks were not recorded as steps" };
  }
  return { pass: false, cause: "missing step type", detail: `no embedded scene JSON; canvas steps recorded: ${canvasClicks}; labels ${labels.join(", ")} not verified` };
}

function scoreP14(input: ScoreInput): { pass: boolean; cause: string; detail: string } {
  const text = `${input.page.title || ""} ${input.page.text || ""} ${evidence(input)}`;
  const stepText = input.workflow.steps.map((step) => `${step.label} ${step.identity?.text || ""} ${step.identity?.name || ""}`).join("\n");
  return scoreBotWall({ expect: input.expect, replay: input.replay, pageText: text, stepText });
}

function evidence(input: ScoreInput): string {
  const parts = [input.page.text || "", input.page.title || ""];
  for (const step of input.replay.steps || []) {
    if (step.snapshot?.ax) parts.push(step.snapshot.ax);
    for (const node of step.snapshot?.dom || []) parts.push(node.text || "", node.name || "");
  }
  if (input.replay.failure?.snapshot?.ax) parts.push(input.replay.failure.snapshot.ax);
  for (const node of input.replay.failure?.snapshot?.dom || []) parts.push(node.text || "", node.name || "");
  return parts.join("\n");
}

function argsFor(workflow: WorkflowV2, spec: {
  secret?: string;
  file?: { name: string; path: string };
  byDefault?: Record<string, string>;
  byName?: Record<string, string>;
}): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const input of workflow.inputs) {
    if (input.type === "secret") args[input.name] = spec.secret || "BaoProof-replay-9";
    else if (input.type === "file" && spec.file) args[input.name] = spec.file;
    else if (spec.byName && spec.byName[input.name] != null) args[input.name] = spec.byName[input.name];
    else if (input.default && spec.byDefault && spec.byDefault[input.default] != null) args[input.name] = spec.byDefault[input.default];
    else if (input.default) args[input.name] = input.default;
  }
  return args;
}

function summarizeWorkflow(workflow: WorkflowV2, openUrl: string, recordError: string): Record<string, unknown> {
  const actions: Record<string, number> = {};
  for (const step of workflow.steps) actions[step.action] = (actions[step.action] || 0) + 1;
  return {
    id: workflow.id,
    openUrl,
    startUrl: workflow.startUrl,
    steps: workflow.steps.length,
    actions,
    inputs: workflow.inputs.map((input) => `${input.name}:${input.type}${input.default ? `=${input.default}` : ""}`),
    labels: workflow.steps.map((step) => `${step.action} ${step.label}`).slice(0, 40),
    recordError: recordError || undefined,
  };
}

function healWhy(heal: HealView): string {
  const step = heal.failedStep;
  return [
    step?.label || step?.id || heal.id || "heal",
    step?.action,
    heal.model?.name ? `model ${heal.model.name}` : "no model",
    heal.postconditionPassed ? "postcondition passed" : "postcondition did not pass",
    heal.proposedPatch ? "patch proposed" : "no patch",
  ].filter(Boolean).join(": ");
}

function makeFiles(id: string): RunFiles {
  const dir = path.join(ROOT, "files");
  mkdirSync(dir, { recursive: true });
  const recordFile = path.join(dir, `${id}-record.txt`);
  const replayA = path.join(dir, `${id}-replay-a.txt`);
  const replayB = path.join(dir, `${id}-replay-b.txt`);
  writeFileSync(recordFile, `proof record ${id}\n`);
  writeFileSync(replayA, `proof replay a ${id}\n`);
  writeFileSync(replayB, `proof replay b ${id}\n`);
  const recordImage = path.join(dir, `${id}-record.png`);
  const imageA = path.join(dir, `${id}-replay-a.png`);
  const imageB = path.join(dir, `${id}-replay-b.png`);
  writeFileSync(recordImage, PNG);
  writeFileSync(imageA, PNG);
  writeFileSync(imageB, Buffer.concat([PNG, Buffer.from([runByte(id), 1])]));
  return { recordFile, replayFile: [replayA, replayB], recordImage, replayImage: [imageA, imageB] };
}

function runByte(id: string): number {
  return id.charCodeAt(1) || 1;
}

async function saveShot(port: number, home: string, id: string, task: string, run: number, size?: { width: number; height: number }): Promise<string | undefined> {
  const file = `${task}-r${run}.png`;
  try {
    await call(port, "POST", "/api/replay/shot", { id, file, ...size });
  } catch {
    return undefined;
  }
  const src = path.join(home, "shots", file);
  if (!existsSync(src)) return undefined;
  return publish(src, file);
}

function copyFrames(home: string, runId: string | undefined, task: string, run: number): string[] {
  if (!runId) return [];
  const dir = path.join(home, "shots", "runs", runId);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((name) => name.endsWith(".after.png")).sort();
  const last = names[names.length - 1];
  return last ? [publish(path.join(dir, last), `${task}-r${run}-end.png`)] : [];
}

function publish(src: string, name: string): string {
  const dest = path.join(ARTIFACTS, name);
  writeFileSync(dest, readFileSync(src));
  try {
    writeFileSync(path.join(PUBLIC_ARTIFACTS, name), readFileSync(src));
  } catch { /* the public artifact dir is optional */ }
  return `docs/proof/realworld/artifacts/${name}`;
}

function writeReel(task: string, run: number, frames: string[]): string | undefined {
  const pngs = frames
    .map((item) => path.join(ROOT, "artifacts", path.basename(item)))
    .filter((file) => existsSync(file));
  if (pngs.length < 2 || !existsSync("/usr/bin/ffmpeg")) return undefined;
  const dir = path.join(tmpdir(), `bao-reel-${task}-${run}`);
  mkdirSync(dir, { recursive: true });
  pngs.forEach((file, index) => writeFileSync(path.join(dir, `frame-${String(index + 1).padStart(4, "0")}.png`), readFileSync(file)));
  const dest = path.join(ARTIFACTS, `${task}-r${run}-keyframes.webm`);
  const result = spawnSync("/usr/bin/ffmpeg", [
    "-y", "-framerate", "1", "-i", path.join(dir, "frame-%04d.png"),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-c:v", "libvpx", "-b:v", "800k", "-an", dest,
  ], { encoding: "utf8" });
  if (result.status !== 0 || !existsSync(dest)) return undefined;
  try { writeFileSync(path.join(PUBLIC_ARTIFACTS, path.basename(dest)), readFileSync(dest)); } catch { /* optional */ }
  return `docs/proof/realworld/artifacts/${path.basename(dest)}`;
}

function newestCsv(files: string[]): string | undefined {
  let best: { file: string; mtime: number } | undefined;
  for (const file of files) {
    let mtime = 0;
    try { mtime = statSync(file).mtimeMs; } catch { continue; }
    if (!best || mtime >= best.mtime) best = { file, mtime };
  }
  return best?.file;
}

function newCsvs(since: number): string[] {
  const roots = [
    path.join(process.env.HOME || "/home/ubuntu", "Downloads"),
    "/home/ubuntu/Downloads",
    "/tmp",
  ];
  const found: string[] = [];
  for (const root of roots) walkCsv(root, since, found, 0);
  return [...new Set(found)];
}

function walkCsv(dir: string, since: number, found: string[], depth: number): void {
  if (depth > 4 || !existsSync(dir)) return;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (/^(Cache|Code Cache|GPUCache|ShaderCache|GrShaderCache|GraphiteDawnCache)$/.test(name)) continue;
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (depth === 0 && dir === "/tmp" && !/^bao-(replay|profile|proof|runs)/.test(name)) continue;
      walkCsv(full, since, found, depth + 1);
    } else if (name.toLowerCase().endsWith(".csv") && st.mtimeMs >= since - 2000) {
      found.push(full);
    }
  }
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const headers = splitCsv(lines[0] || "");
  const rows = lines.slice(1).map(splitCsv).filter((row) => row.some((cell) => cell.trim()));
  return { headers, rows };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted && ch === "\"" && line[i + 1] === "\"") { cur += "\""; i += 1; continue; }
    if (ch === "\"") { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function lastCount(text: string): number | null {
  const matches = [...text.matchAll(/out of ([\d,]+) studies/gi)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  return Number(last[1]!.replace(/,/g, ""));
}

/** A live result count is not a stable postcondition. "Clear Filters (4)" changes as studies change. */
function dropVolatileExpects(workflow: WorkflowV2): WorkflowV2 {
  const volatile = /^(Clear|Remove) Filters \(\d+\)$|^Loading results/i;
  return {
    ...workflow,
    steps: workflow.steps.map((step) => {
      const next = { ...step };
      if (next.expect?.match && volatile.test(next.expect.match)) delete next.expect;
      if (next.postcondition?.match && volatile.test(next.postcondition.match)) delete next.postcondition;
      return next;
    }),
  };
}

function dateForms(value: string): string[] {
  const forms = [value];
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!iso) return forms;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const short = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(iso[2]) - 1];
  const abbr = short[Number(iso[2]) - 1];
  if (!month || !abbr) return forms;
  const day = String(Number(iso[3]));
  const year = iso[1]!;
  forms.push(
    `${day} ${month},${year}`,
    `${day} ${month}, ${year}`,
    `${day} ${month} ${year}`,
    `${day} ${abbr},${year}`,
    `${day} ${abbr}, ${year}`,
    `${day} ${abbr} ${year}`,
  );
  return forms;
}

function dobIn(text: string): string {
  const match = text.match(/\b\d{1,2} [A-Z][a-z]+,?\s*\d{4}\b/);
  return match ? match[0] : "";
}

function fileName(args: Record<string, unknown>): string {
  for (const value of Object.values(args)) {
    if (value && typeof value === "object" && "name" in value && typeof (value as { name?: string }).name === "string") {
      return (value as { name: string }).name;
    }
  }
  return "";
}

function findArg(args: Record<string, unknown>, pattern: RegExp): string {
  for (const value of Object.values(args)) if (typeof value === "string" && pattern.test(value)) return value;
  return "";
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function hostPath(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`;
  } catch {
    return value;
  }
}

/** Run 2 books one more night than the recording. A range is one date step; older runs stored the days as clicks. */
function shiftBookingNights(workflow: WorkflowV2): WorkflowV2 | undefined {
  const endName = workflow.steps.find((step) => step.datePicker?.endInput)?.datePicker?.endInput;
  if (endName) {
    let bumped = false;
    const inputs = workflow.inputs.map((input) => {
      if (input.name !== endName) return input;
      const relative = bumpDay(input.relative);
      if (!relative) return input;
      bumped = true;
      const nextDefault = input.default === input.relative ? relative : bumpDay(input.default) || input.default;
      return { ...input, relative, default: nextDefault };
    });
    if (bumped) return { ...workflow, inputs };
  }
  const days = workflow.steps.filter((step) => step.action === "click" && /^\d{2}$/.test(step.identity?.text || step.identity?.name || ""));
  if (days.length < 2) return undefined;
  const start = Number(days[0]?.identity?.text || days[0]?.identity?.name);
  const end = Number(days[days.length - 1]?.identity?.text || days[days.length - 1]?.identity?.name);
  if (!start || !end || end <= start) return undefined;
  const from = String(end).padStart(2, "0");
  const to = String(start + 3).padStart(2, "0");
  if (from === to) return undefined;
  const steps = workflow.steps.map((step) => {
    if (step !== days[days.length - 1]) return step;
    return JSON.parse(JSON.stringify(step).split(`"${from}"`).join(`"${to}"`)) as typeof step;
  });
  return { ...workflow, steps };
}

function bumpDay(value: string | undefined): string | undefined {
  const match = /^([+-])(\d+)d$/.exec(value || "");
  if (!match) return undefined;
  const signed = (match[1] === "-" ? -1 : 1) * Number(match[2]) + 1;
  return signed < 0 ? `-${Math.abs(signed)}d` : `+${signed}d`;
}

function vectorGo(step: WorkflowStep): WorkflowStep {
  return {
    ...step,
    action: "click",
    key: undefined,
    label: "Click \"Go\"",
    identity: {
      surface: "dom",
      role: "button",
      id: "searchButton",
      tag: "input",
      nameAttr: "go",
      cssPath: "#searchButton",
      text: "Go",
      path: [],
    },
    locators: [
      { kind: "css", value: "#searchButton" },
      { kind: "xpath", value: "//*[@id=\"searchButton\"]" },
    ],
  };
}

function withSkin(value: string, skin: string): string {
  try {
    const url = new URL(value);
    url.searchParams.set("useskin", skin);
    return url.toString();
  } catch {
    return value;
  }
}

function publicArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (/pass|secret/i.test(key)) out[key] = "[secret]";
    else if (value && typeof value === "object" && "path" in value) out[key] = { name: (value as { name?: string }).name };
    else out[key] = value;
  }
  return out;
}

function redact<T>(value: T): T {
  const json = JSON.stringify(value).replace(/BaoProof-[A-Za-z0-9-]+/g, "[secret]");
  return JSON.parse(json) as T;
}

function sanitizeRun(run: RunView): RunView {
  return JSON.parse(JSON.stringify(run, (key, value) => {
    if (key === "screenshot" || key === "rawResponse" || key === "prompt") return undefined;
    if (key === "ax" && typeof value === "string" && value.length > 5000) return value.slice(0, 5000);
    return value;
  })) as RunView;
}

function writeTasks(): void {
  const body = TASKS.map((task) => ({
    id: task.id,
    title: task.title,
    site: task.site,
    openUrl: task.openUrl || "",
    mac: task.mac === true,
    expect: task.expect,
  }));
  writeFileSync(path.join(ROOT, "tasks.json"), `${JSON.stringify(body, null, 2)}\n`);
}

function writeResults(results: TaskResult[]): void {
  const lines = [
    "# Real-world proof",
    "",
    `Measured on Linux with headless Chrome from v1/desktop. Replay video is macOS-only, so each browser replay saved keyframes (and a keyframe webm when ffmpeg could encode one). Pass means both the doc's check and 0 model calls. A task with expect needs_human passes when the replay pauses for a person and that check holds.`,
    "",
    "| Task | Pass | Model calls | Heals | First failure |",
    "|---|---|---|---|---|",
  ];
  for (const result of results) {
    lines.push(`| ${result.id} ${result.title} | ${result.pass} | ${escapeCell(result.modelCalls)} | ${escapeCell(result.heals)} | ${escapeCell(result.firstFailure || "—")} |`);
  }
  lines.push("", "## Failure causes", "");
  const counts = new Map<string, number>();
  for (const result of results) {
    if (!result.cause || result.pass === "2/2" || result.pass === "needs Mac") continue;
    counts.set(result.cause, (counts.get(result.cause) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!ranked.length) lines.push("No browser task failed.");
  ranked.slice(0, 3).forEach(([cause, count], index) => {
    lines.push(`${index + 1}. ${cause} — ${count} task${count === 1 ? "" : "s"}`);
  });
  lines.push("", "## Per task", "");
  for (const result of results) {
    lines.push(`### ${result.id} ${result.title}`, "", `Site: ${result.site}`, "");
    if (result.note) lines.push(result.note, "");
    lines.push("Recorded:", "", "```json", JSON.stringify(result.recorded, null, 2), "```", "");
    for (const [index, replay] of result.replays.entries()) {
      lines.push(`Replay ${index + 1}: ${replay.pass ? "pass" : "fail"} (${replay.status}), model calls ${replay.modelCalls}, heals ${replay.heals.length ? replay.heals.join("; ") : "0"}`);
      if (!replay.pass) lines.push(`First failure: ${replay.failedStep || "check"} — ${replay.detail}`);
      lines.push("");
    }
    if (result.artifacts.length) {
      lines.push("Artifacts:", "");
      for (const artifact of result.artifacts) lines.push(`- \`${artifact}\``);
      lines.push("");
    }
  }
  writeFileSync(path.join(ROOT, "RESULTS.md"), `${lines.join("\n")}\n`);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 400);
}

async function call(port: number, method: string, pathname: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const type = res.headers.get("content-type") || "";
  if (res.ok && type.includes("text/csv")) return text;
  let json: { error?: string } = {};
  try { json = text ? JSON.parse(text) as { error?: string } : {}; } catch { json = { error: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`${method} ${pathname} ${res.status} ${json.error || text.slice(0, 300)}`);
  return json;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
