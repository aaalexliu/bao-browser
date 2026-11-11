export const title = "One shared Playwright shutdown";

export function state(vars) {
  const jobs = Object.values(vars.jobs).filter((stage) => stage !== "absent");
  if (jobs.length > 1) return "Two shutdown jobs";
  switch (jobs[0]) {
    case undefined: return "Running";
    case "queued": return "One shutdown queued";
    case "request": return "Requesting browser close";
    case "release": return "Releasing profile processes";
    case "detach": return "Disconnecting Playwright";
    case "settled": return "Shared shutdown settled";
    default: throw new Error(`Unknown job stage: ${jobs[0]}`);
  }
}

export function step(action) {
  switch (action) {
    case "Request": return "a close or disconnect arrives";
    case "Start": return "the shutdown microtask starts";
    case "BrowserCloseReturns": return "the browser close request returns";
    case "ReleaseReturns": return "profile cleanup returns";
    case "Settle": return "shutdown returns or rejects";
    case "Done": return "no work remains";
    default: throw new Error(`Unknown action: ${action}`);
  }
}
