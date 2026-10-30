// Twenty-four good intent sentences. Six are the calibration goods. The rest
// name a real case control or a param. The lint must not reject these.

import type { LintTarget } from "./lint";

export interface GoodIntent {
  id: string;
  text: string;
  target?: LintTarget;
  secrets?: string[];
}

const type = (name: string, input?: string): LintTarget => ({
  action: "type",
  role: "textbox",
  name,
  label: name,
  input: input || name,
});

export const GOOD_INTENTS: GoodIntent[] = [
  { id: "g1", text: "Type the visitor's name into the Name field.", target: type("Name", "name") },
  { id: "g2", text: "Click Save to store the form.", target: { action: "click", role: "button", name: "Save", label: "Save" } },
  { id: "g3", text: "Type {{city}} on the Address tab.", target: { action: "type", role: "textbox", name: "Address", label: "Address", input: "city" } },
  { id: "g4", text: "Confirm deleting the item.", target: { action: "click", role: "button", name: "Confirm", label: "Confirm" } },
  { id: "g5", text: "Type the pin into the pin field.", target: type("pin", "pin"), secrets: ["pin-9999"] },
  { id: "g6", text: "Save the profile name and leave the page on Saved." },
  { id: "g7", text: "Type {{name}} into the Name field.", target: type("Name", "name") },
  { id: "g8", text: "Click Save to store the name.", target: { action: "click", role: "button", name: "Save", label: "Save" } },
  { id: "g9", text: "Type {{who}} into the Email field.", target: type("Email", "who") },
  { id: "g10", text: "Type {{note}} into the Note field.", target: type("Note", "note") },
  { id: "g11", text: "Click Send to send the note.", target: { action: "click", role: "button", name: "Send", label: "Send" } },
  { id: "g12", text: "Type {{username}} into the Username field.", target: type("Username", "username") },
  { id: "g13", text: "Type the password into the password field.", target: type("password", "password"), secrets: ["SuperSecretPassword!"] },
  { id: "g14", text: "Click Log in to sign in.", target: { action: "click", role: "button", name: "Log in", label: "Log in" } },
  { id: "g15", text: "Click Delete to arm the delete.", target: { action: "click", role: "button", name: "Delete", label: "Delete" } },
  { id: "g16", text: "Click Confirm to finish the delete.", target: { action: "click", role: "button", name: "Confirm", label: "Confirm" } },
  { id: "g17", text: "Upload the file into the file field.", target: { action: "upload", role: "textbox", name: "file", label: "file", input: "file" } },
  { id: "g18", text: "Check Terms to accept the terms.", target: { action: "check", role: "checkbox", name: "Terms", label: "Terms" } },
  { id: "g19", text: "Click the Address tab.", target: { action: "click", role: "tab", name: "Address", label: "Address" } },
  { id: "g20", text: "Type {{query}} into the search field.", target: type("search", "query"), secrets: ["Ada Lovelace"] },
  { id: "g21", text: "Press Enter to run the search.", target: { action: "key", name: "search", label: "search" } },
  { id: "g22", text: "Type {{amount}} into the Amount field.", target: type("Amount", "amount") },
  { id: "g23", text: "Click Pay to start the payment.", target: { action: "click", role: "button", name: "Pay", label: "Pay" } },
  { id: "g24", text: "Type USD into the currency field.", target: { action: "type", role: "textbox", name: "currency", label: "currency" } },
];
