// Bao — Tier-C item 6 (opt-in, invasive): force closed shadow roots OPEN at creation
// so the deterministic Tier-A shadow-piercing capture can reach inside them. Runs in
// the MAIN world at document_start, before page scripts create their roots — a closed
// root made before this runs is unaffected, so winning the document_start race matters.
//
// This is an escalation, not a baseline: it globally changes page semantics and can
// break sites that rely on closed encapsulation, so the SW only registers it when the
// user opts into "aggressive capture" mode (background.ts: baoSetForceOpen).

type AttachShadow = typeof Element.prototype.attachShadow & { __baoForced?: boolean };

(() => {
  const orig = Element.prototype.attachShadow as AttachShadow;
  if (orig.__baoForced) return; // idempotent
  const patched = function attachShadow(this: Element, init: ShadowRootInit): ShadowRoot {
    return orig.call(this, Object.assign({}, init, { mode: "open" as const }));
  } as AttachShadow;
  patched.__baoForced = true;
  Element.prototype.attachShadow = patched;
})();

export {};
