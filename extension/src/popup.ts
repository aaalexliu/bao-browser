// The popup is the user gesture Chrome requires for a host-permission prompt.
// permissions.request has to be the first await. An earlier await drops the gesture.

export {};

const statusEl = document.getElementById("status");
const allow = document.getElementById("allow");
const record = document.getElementById("record");
const stopButton = document.getElementById("stop");

function show(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

async function refresh(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ op: "popup-status" });
  const body = response as { linked?: boolean; phase?: string; extensionId?: string; error?: string };
  const link = body.linked ? "linked to Bao" : "Bao isn't running";
  show(`${link}. ${body.phase || "idle"}.`);
}

function patternFor(url: string): string {
  const parsed = new URL(url);
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${parsed.hostname}${port}/*`;
}

allow?.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//.test(tab.url)) {
    show("This tab is not a web page.");
    return;
  }
  const pattern = patternFor(tab.url);
  const granted = await chrome.permissions.request({ origins: [pattern] });
  show(granted ? `Allowed ${pattern}` : "Not allowed.");
});

record?.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//.test(tab.url)) {
    show("Open the page you want to record first.");
    return;
  }
  const granted = await chrome.permissions.request({ origins: [patternFor(tab.url)] });
  if (!granted) {
    show("Bao needs permission for this site before it can record.");
    return;
  }
  const response = await chrome.runtime.sendMessage({ op: "popup-record" });
  const body = response as { ok?: boolean; error?: string };
  show(body.ok ? "Recording. The badge says REC." : (body.error || "Could not record."));
});

stopButton?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ op: "popup-stop" });
  show("Stopped.");
});

void refresh();
