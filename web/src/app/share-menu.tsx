"use client";

import { useState } from "react";

export function ShareMenu({
  link,
  publishHref,
  publishEnabled,
  publishWhy,
  fileName,
  fileText,
  exportEnabled,
  exportWhy,
}: {
  link: string;
  publishHref: string;
  publishEnabled: boolean;
  publishWhy: string;
  fileName: string;
  fileText: string;
  exportEnabled: boolean;
  exportWhy: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  function download(): void {
    const blob = new Blob([fileText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="share" data-testid="share-menu">
      <button type="button" data-testid="share-open" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>
        Share
      </button>
      {open ? (
        <div className="share-panel" data-testid="share-panel" role="menu">
          <button
            type="button"
            role="menuitem"
            data-testid="share-copy"
            data-copy={link}
            onClick={() => {
              void navigator.clipboard?.writeText(link).then(() => setCopied(true)).catch(() => setCopied(false));
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          {publishEnabled ? (
            <a className="button" role="menuitem" data-testid="share-publish" href={publishHref}>Publish to marketplace</a>
          ) : (
            <button type="button" role="menuitem" data-testid="share-publish" disabled>Publish to marketplace</button>
          )}
          {publishEnabled ? null : <p className="share-why" data-testid="share-publish-why">{publishWhy}</p>}
          <button type="button" role="menuitem" data-testid="share-export" disabled={!exportEnabled} onClick={() => { if (exportEnabled) download(); }}>
            Export file
          </button>
          {exportEnabled ? null : <p className="share-why" data-testid="share-export-why">{exportWhy}</p>}
        </div>
      ) : null}
    </div>
  );
}
