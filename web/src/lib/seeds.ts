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
    typeStep("user", 0, "username", cap("Type into Username", cite("Username", "label")), css("#username"), { kind: "value", match: "{{username}}" }),
    typeStep("pass", 1, "password", cap("Type the password"), css("#password"), { kind: "element", locators: [css("#password")] }, true),
    clickStep("go", 2, cap("Click Log in", cite("Log in", "text")), role("button", "Log in"), { kind: "text", match: "Welcome {{username}}" }),
  ]),
  seed("fixture-row", "Pick a row on the Bao fixture", "Fixture", FIXTURE, [
    input("row", "choice", "Row", ["Ada", "Grace"]),
  ], [
    {
      id: "row",
      index: 0,
      action: "click",
      caption: cap("Click the row named {{row}}"),
      timeoutMs: 8000,
      target: { locators: [css("[data-testid=row]")] },
      selection: { by: "text", input: "row" },
      check: { kind: "text", match: "Picked {{row}}", timeoutMs: 4000 },
    },
  ]),
  seed("fixture-username", "Fill the fixture username", "Fixture", FIXTURE, [
    input("username", "text", "Username"),
  ], [
    typeStep("user", 0, "username", cap("Type into Username", cite("Username", "label")), css("#username"), { kind: "value", match: "{{username}}" }),
  ]),
  seed("fixture-upload", "Upload a file on the Bao fixture", "Fixture", FIXTURE, [
    input("file", "file", "File"),
  ], [
    {
      id: "file",
      index: 0,
      action: "upload",
      caption: cap("Upload a file"),
      timeoutMs: 8000,
      file: { input: "file" },
      target: { locators: [css("#file")] },
      check: { kind: "element", timeoutMs: 4000, locators: [css("#file")] },
    },
  ]),
  seed("wikipedia-search", "Search Wikipedia", "Research", "https://en.wikipedia.org/wiki/Main_Page", [
    input("query", "text", "Search query"),
  ], [
    typeStep("q", 0, "query", cap("Type the search query"), css("#searchInput"), { kind: "element", locators: [css("#searchInput")] }),
    {
      id: "go",
      index: 1,
      action: "key",
      key: "Enter",
      caption: cap("Submit the search"),
      timeoutMs: 8000,
      check: { kind: "url", match: "{{query}}", timeoutMs: 12000 },
    },
  ]),
  seed("public-form", "Submit a public form", "Forms", "https://httpbin.org/forms/post", [
    input("name", "text", "Customer name"),
    input("note", "text", "Delivery note"),
  ], [
    typeStep("name", 0, "name", cap("Type the customer name", cite("Customer name:", "label")), role("textbox", "Customer name:"), { kind: "value", match: "{{name}}" }),
    typeStep("note", 1, "note", cap("Type the delivery note", cite("Delivery instructions:", "label")), role("textbox", "Delivery instructions:"), { kind: "value", match: "{{note}}" }),
    clickStep("send", 2, cap("Submit the order", cite("Submit order", "text")), role("button", "Submit order"), { kind: "url", match: "/post" }),
  ]),
];

function seed(id: string, name: string, category: string, startUrl: string, inputs: unknown[], steps: unknown[]): Seed {
  return {
    id,
    category,
    document: {
      schema: "bao.workflow/v4",
      id,
      name,
      startUrl,
      createdAt: 1710000000000,
      inputs,
      steps,
    },
  };
}

function input(name: string, type: string, label: string, choices?: string[]) {
  return { name, type, label, supply: "must", ...(choices ? { choices } : {}) };
}

function css(value: string) {
  return { kind: "css", value };
}

function role(roleName: string, name: string) {
  return { kind: "role", role: roleName, name };
}

/** A citation is a string the page element carries. Leave it out when no element string fits. */
function cap(text: string, citation?: { text: string; source: string }) {
  return { text, ...(citation ? { citation } : {}) };
}

function cite(text: string, source: "text" | "label") {
  return { text, source };
}

function typeStep(
  id: string,
  index: number,
  inputName: string,
  caption: ReturnType<typeof cap>,
  locator: { kind: string; value?: string; role?: string; name?: string },
  post: { kind: string; match?: string; locators?: unknown[] },
  sensitive = false,
) {
  return {
    id,
    index,
    action: "type",
    caption,
    timeoutMs: 8000,
    text: { input: inputName },
    ...(sensitive ? { sensitive: true } : {}),
    target: { locators: [locator] },
    check: { ...post, timeoutMs: 8000 },
  };
}

function clickStep(
  id: string,
  index: number,
  caption: ReturnType<typeof cap>,
  locator: { kind: string; value?: string; role?: string; name?: string },
  post: { kind: string; match?: string },
) {
  return {
    id,
    index,
    action: "click",
    caption,
    timeoutMs: 8000,
    target: { locators: [locator] },
    check: { ...post, timeoutMs: 8000 },
  };
}
