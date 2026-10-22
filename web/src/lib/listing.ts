/** Marketplace card copy. A clean publish replay is a replay even when no device run was stored. */
export function listingStat(runs: number, lastGreen: string, verifiedReplay = false): string {
  const count = Number(runs) || 0;
  if (verifiedReplay && count < 1) return "Verified by 1 replay";
  if (count < 1) return "No runs yet";
  const noun = count === 1 ? "1 run" : `${count} runs`;
  return `${noun} · last green ${lastGreen}`;
}

export function workflowCountLabel(count: number): string {
  const n = Number(count) || 0;
  return n === 1 ? "1 workflow" : `${n} workflows`;
}
