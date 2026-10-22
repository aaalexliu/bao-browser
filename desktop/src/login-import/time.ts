// Probe times use the machine zone. The short zone name is part of the label
// so a UTC clock and a local clock are not written the same way.

export function formatProbeTime(at: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(at));
}
