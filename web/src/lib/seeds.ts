// Example workflows. They stay private until a device replays them and the
// author confirms the public preview. Passwords are not in this file.

const FIXTURE = "http://127.0.0.1/fixture.html";

interface Seed {
  id: string;
  category: string;
  document: Record<string, unknown>;
}

export const SEED_WORKFLOWS: Seed[] = [
  seed("fixture-sign-in", "Sign in on the Bao fixture", "Forms", FIXTURE, [
    input("username", "text", "Username"),
    input("password", "secret", "Password"),
  ], [
    typeStep("user", 0, "username", "Type the username", { id: "username", nameAttr: "username" }, { kind: "value", match: "{{username}}" }),
    typeStep("pass", 1, "password", "Type the password", { id: "password", nameAttr: "password" }, { kind: "element", identity: ident({ id: "password" }) }, true),
    clickStep("go", 2, "Click Log in", { id: "login-btn", testId: "login", role: "button", text: "Log in", tag: "button" }, { kind: "text", match: "Welcome {{username}}" }),
  ]),
  seed("fixture-row", "Pick a row on the Bao fixture", "Fixture", FIXTURE, [
    { name: "row", type: "choice", label: "Row", required: true, choices: ["Ada", "Grace"] },
  ], [
    {
      id: "row",
      index: 0,
      action: "click",
      label: "Click the row named {{row}}",
      surface: "dom",
      timeoutMs: 8000,
      identity: ident({ role: "li", testId: "row", tag: "li" }),
      selection: { by: "text", input: "row" },
      postcondition: { kind: "text", match: "Picked {{row}}", timeoutMs: 4000 },
    },
  ]),
  seed("fixture-username", "Fill the fixture username", "Fixture", FIXTURE, [
    input("username", "text", "Username"),
  ], [
    typeStep("user", 0, "username", "Type the username", { id: "username", nameAttr: "username" }, { kind: "value", match: "{{username}}" }),
  ]),
  seed("fixture-upload", "Upload a file on the Bao fixture", "Fixture", FIXTURE, [
    { name: "file", type: "file", label: "File", required: true },
  ], [
    {
      id: "file",
      index: 0,
      action: "upload",
      label: "Upload a file",
      surface: "dom",
      timeoutMs: 8000,
      input: "file",
      value: "{{file}}",
      identity: ident({ id: "file", nameAttr: "file", testId: "file", tag: "input" }),
      postcondition: { kind: "element", timeoutMs: 4000, identity: ident({ id: "file", testId: "file" }) },
    },
  ]),
  seed("wikipedia-search", "Search Wikipedia", "Research", "https://en.wikipedia.org/wiki/Main_Page", [
    input("query", "text", "Search query"),
  ], [
    typeStep("q", 0, "query", "Type the search query", { id: "searchInput", nameAttr: "search", label: "Search Wikipedia", role: "input" }, { kind: "element", identity: ident({ id: "searchInput", role: "input" }) }),
    {
      id: "go",
      index: 1,
      action: "key",
      key: "Enter",
      label: "Submit the search",
      surface: "dom",
      timeoutMs: 8000,
      postcondition: { kind: "url", match: "search", timeoutMs: 8000 },
    },
  ]),
  seed("public-form", "Submit a public form", "Forms", "https://httpbin.org/forms/post", [
    input("name", "text", "Customer name"),
    input("note", "text", "Delivery note"),
  ], [
    typeStep("name", 0, "name", "Type the customer name", { nameAttr: "custname", label: "Customer name:", tag: "input" }, { kind: "value", match: "{{name}}" }),
    typeStep("note", 1, "note", "Type the delivery note", { nameAttr: "comments", label: "Delivery instructions:", tag: "textarea", role: "textbox" }, { kind: "value", match: "{{note}}" }),
    clickStep("send", 2, "Submit the order", { role: "button", text: "Submit order", tag: "button" }, { kind: "url", match: "/post" }),
  ]),
];

function seed(id: string, name: string, category: string, startUrl: string, inputs: unknown[], steps: unknown[]): Seed {
  return {
    id,
    category,
    document: {
      schema: "bao.workflow/v2",
      version: 2,
      id,
      name,
      startUrl,
      createdAt: 1710000000000,
      inputs,
      steps,
    },
  };
}

function input(name: string, type: string, label: string) {
  return { name, type, label, required: true };
}

function ident(partial: Record<string, unknown>) {
  return { surface: "dom", role: "textbox", path: [], ...partial };
}

function typeStep(
  id: string,
  index: number,
  inputName: string,
  label: string,
  identity: Record<string, unknown>,
  post: { kind: string; match?: string; identity?: unknown },
  sensitive = false,
) {
  return {
    id,
    index,
    action: "type",
    label: sensitive ? "Type the password" : label,
    surface: "dom",
    timeoutMs: 8000,
    input: inputName,
    value: `{{${inputName}}}`,
    ...(sensitive ? { sensitive: true } : {}),
    identity: ident(identity),
    postcondition: { ...post, timeoutMs: 8000 },
  };
}

function clickStep(
  id: string,
  index: number,
  label: string,
  identity: Record<string, unknown>,
  post: { kind: string; match?: string },
) {
  return {
    id,
    index,
    action: "click",
    label,
    surface: "dom",
    timeoutMs: 8000,
    identity: ident(identity),
    postcondition: { ...post, timeoutMs: 8000 },
  };
}
