import type { DesktopMcpClient, DesktopMcpPreview } from "./desktop-mcp-config";
import { htmlEsc } from "./views";

const CLIENT_NAMES: Record<DesktopMcpClient, string> = { claude: "Claude Desktop", chatgpt: "ChatGPT" };
let previewPending = false;

export function desktopMcpSettings(): string {
  return `<div class="card" id="desktop-mcp-settings">
    <h3>Connect desktop apps</h3>
    <p>Add Bao's local MCP server. Review the exact config diff before Bao changes a file.</p>
    <div class="desktop-mcp-actions">
      <button type="button" data-desktop-mcp="claude">Add to Claude</button>
      <button type="button" data-desktop-mcp="chatgpt">Add to ChatGPT</button>
    </div>
    <p class="quiet">ChatGPT uses the Codex config on this Mac. This change also affects the Codex CLI and IDE extension. Bao pre-approves only its own tools, so ChatGPT runs them without asking first.</p>
    <p id="desktop-mcp-feedback" role="status"></p>
    <p id="desktop-mcp-error" role="alert"></p>
  </div>`;
}

export function bindDesktopMcp(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-desktop-mcp]").forEach((button) => {
    button.disabled = previewPending;
    button.onclick = async () => {
      if (previewPending) return;
      previewPending = true;
      document.querySelectorAll<HTMLButtonElement>("[data-desktop-mcp]").forEach((choice) => { choice.disabled = true; });
      const client = button.dataset.desktopMcp as DesktopMcpClient;
      const feedback = document.getElementById("desktop-mcp-feedback")!;
      const error = document.getElementById("desktop-mcp-error")!;
      feedback.textContent = "Reading the config. No changes yet.";
      error.textContent = "";
      try {
        const preview = await request<DesktopMcpPreview>("preview", { client });
        feedback.textContent = "";
        showPreview(preview);
      } catch (err) {
        feedback.textContent = "";
        error.textContent = message(err);
      } finally {
        previewPending = false;
        document.querySelectorAll<HTMLButtonElement>("[data-desktop-mcp]").forEach((choice) => { choice.disabled = false; });
      }
    };
  });
}

function showPreview(preview: DesktopMcpPreview): void {
  document.getElementById("desktop-mcp-confirm")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "desktop-mcp-confirm";
  dialog.setAttribute("aria-labelledby", "desktop-mcp-title");
  const name = CLIENT_NAMES[preview.client];
  const changed = preview.action !== "unchanged";
  const verb = preview.action === "update" ? "Update" : "Add";
  dialog.innerHTML = `<h2 id="desktop-mcp-title" tabindex="-1">${changed ? `${verb} Bao ${preview.action === "update" ? "in" : "to"} ${name}?` : `Bao is already set up in ${name}`}</h2>
    <p class="desktop-mcp-path">${htmlEsc(preview.file)}</p>
    <p>${preview.action === "update" ? "An existing Bao entry will change. Other settings and explicit per-tool rules stay as they are." : changed ? "Bao will add one local server entry. Other settings stay as they are." : "This config already has the proposed Bao settings. Nothing will be written."}</p>
    ${preview.client === "chatgpt" ? `<p>This is the shared Codex config. The change also applies to the Codex CLI and IDE extension. Bao pre-approves only its own tools, so ChatGPT runs them without asking first.</p>` : ""}
    ${changed && preview.client !== "chatgpt" ? `<p>Tool approval stays with you. No blanket approval is added.</p>` : ""}
    ${changed ? `<h3>Exact config diff</h3>
      <p class="quiet">Lines starting with - are removed. Lines starting with + are added.</p>
      <pre aria-label="Exact config diff">${htmlEsc(preview.diff)}</pre>
      <p class="desktop-mcp-path">${preview.backup ? `Before replacing the file, Bao saves a backup at ${htmlEsc(preview.backup)}. Restore that file to undo this change.` : "This creates a new config file with private permissions. There is no earlier file to back up."}</p>` : ""}
    <p id="desktop-mcp-write-status" role="status"></p>
    <p id="desktop-mcp-write-error" role="alert"></p>
    <div class="desktop-mcp-actions">
      <button type="button" id="desktop-mcp-cancel">${preview.action === "update" ? "Leave unchanged" : "Close"}</button>
      ${changed ? `<button type="button" class="primary" id="desktop-mcp-write">${verb} Bao</button>` : ""}
    </div>`;
  document.body.append(dialog);
  let writing = false;
  dialog.addEventListener("cancel", (event) => { if (writing) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    dialog.remove();
    document.querySelector<HTMLButtonElement>(`[data-desktop-mcp="${preview.client}"]`)?.focus();
  });
  const cancel = dialog.querySelector<HTMLButtonElement>("#desktop-mcp-cancel")!;
  cancel.onclick = () => dialog.close();
  const write = dialog.querySelector<HTMLButtonElement>("#desktop-mcp-write");
  if (write) write.onclick = async () => {
    writing = true;
    write.disabled = true;
    cancel.disabled = true;
    dialog.querySelector("#desktop-mcp-write-status")!.textContent = "Saving the approved change.";
    try {
      const result = await request<{ file: string; backup: string | null }>("confirm", { token: preview.token });
      dialog.close();
      const feedback = document.getElementById("desktop-mcp-feedback");
      if (feedback) feedback.textContent = `Bao is set up in ${name}. Restart ${name} to load it. ${result.backup ? `Backup saved at ${result.backup}. Restore that file to undo the change.` : `Created ${result.file}.`}`;
    } catch (err) {
      dialog.querySelector("#desktop-mcp-write-status")!.textContent = "";
      dialog.querySelector("#desktop-mcp-write-error")!.textContent = message(err);
    } finally {
      writing = false;
      cancel.disabled = false;
    }
  };
  dialog.showModal();
  dialog.querySelector<HTMLElement>("#desktop-mcp-title")!.focus();
}

async function request<T>(step: "preview" | "confirm", body: unknown): Promise<T> {
  const response = await fetch(`/api/desktop-mcp/${step}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "Cannot reach Bao. Check that Bao is running, then try again.");
  return result;
}

function message(err: unknown): string {
  return err instanceof Error && !(err instanceof TypeError) ? err.message : "Cannot reach Bao. Check that Bao is running, then try again.";
}
