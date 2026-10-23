// Turns recorderSource() into a page script the extension can register. No eval at runtime.

import { writeFileSync } from "fs";
import { recorderSource } from "../../desktop/src/v1/recorder";

export function writeRecorder(dest: string): void {
  const source = recorderSource();
  const wrapped = [
    "(() => {",
    "  const arm = () => {",
    "    const root = document.documentElement;",
    "    const nonce = root && root.getAttribute(\"data-bao-nonce\");",
    "    if (!nonce) { setTimeout(arm, 0); return; }",
    "    window.__baoRecord = (payload) => {",
    "      window.postMessage({ source: \"bao-record\", nonce: nonce, payload: payload }, \"*\");",
    "    };",
    source,
    "  };",
    "  arm();",
    "})();",
    "",
  ].join("\n");
  writeFileSync(dest, wrapped);
}
