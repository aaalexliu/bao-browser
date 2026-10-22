// Before a run, check the saved site's probe. A dead session stops here.
// Replay does not start, so the run does not fail on a later step.

export const NEEDS_SIGN_IN = "Needs sign-in. The session is not live, so Bao did not start the run. Sign in once in Bao's window.";

export interface NeedsSignIn {
  status: "needs-sign-in";
  steps: [];
  heals: [];
  message: string;
  offerSignIn: true;
  signInUrl: string;
  runId: string;
}

export function isNeedsSignIn(value: { status?: string }): value is NeedsSignIn {
  return value.status === "needs-sign-in";
}

export async function runIfSignedIn<T>(opts: {
  enabled: boolean;
  signInUrl: string;
  runId: string;
  probe: () => Promise<{ signedIn: boolean }>;
  run: () => Promise<T>;
}): Promise<T | NeedsSignIn> {
  if (!opts.enabled) return opts.run();
  let signedIn = false;
  try {
    signedIn = (await opts.probe()).signedIn;
  } catch {
    signedIn = false;
  }
  if (signedIn) return opts.run();
  return {
    status: "needs-sign-in",
    steps: [],
    heals: [],
    message: NEEDS_SIGN_IN,
    offerSignIn: true,
    signInUrl: opts.signInUrl,
    runId: opts.runId,
  };
}
