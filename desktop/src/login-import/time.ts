// Probe times use the machine zone. The short zone name is part of the label
// so a UTC clock and a local clock are not written the same way.

import { formatClock } from "../v1/time";

export function formatProbeTime(at: number): string {
  return formatClock(at);
}
