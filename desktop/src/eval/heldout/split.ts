// Held-out split for batches 2–5. Even FNV-1a is the test half.
// The assignment is a function of the case id, fixed before scoring.

export function heldoutSplit(caseId: string): "dev" | "test" {
  let hash = 0x811c9dc5;
  for (let i = 0; i < caseId.length; i++) {
    hash ^= caseId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2 === 0 ? "test" : "dev";
}
