export const LIVE_LOGIN_INSTRUCTION = "Sign in again in Chrome, then start a new live session.";
export const EXPERIAN_COMMIT_MESSAGE = "The final unfreeze button is on screen. Bao stopped before clicking it.";

const UNKNOWN_STOP = "Bao stopped. Open Chrome to check the page before continuing.";
const STOP_MESSAGES: Record<string, string> = {
  login_wall: LIVE_LOGIN_INSTRUCTION,
  experian_commit: EXPERIAN_COMMIT_MESSAGE,
  stop_before_confirm: "Waiting for you to confirm the final step.",
  bot_wall: "Complete the bot check in Chrome, then start a new live session.",
  "stop-path": "Bao stopped at a path it does not drive.",
  new_target: "The page opened a new window. Bao closed it and stopped.",
  credential_field: "Bao stopped at a credential field. Continue in Chrome.",
  focus_moved: "Focus left the field Bao was typing in, so Bao stopped.",
  stale_ref: "The page changed. Read it again before continuing.",
  unknown_ref: "That control is no longer on the page. Read the page again.",
  denied: "Bao does not use that control. Continue in Chrome.",
  key_not_allowed: "Bao does not use that key. Continue in Chrome.",
  ref_required: "Choose a control before pressing Enter.",
  direction_not_allowed: "Bao cannot scroll in that direction.",
  not_a_field: "Choose a text field before typing.",
  not_a_live_control: "That control is no longer on the page. Read the page again.",
  "element handle expired": "The page changed. Read it again before continuing.",
  "cdp-live refused that text": "Bao did not type that text. Continue in Chrome.",
  "cdp-live does not type secrets": "Bao does not type sign-in details. Continue in Chrome.",
  "cdp-live does not fill secrets": "Bao does not type sign-in details. Continue in Chrome.",
  "cdp-live does not type card numbers": "Bao does not type card details. Continue in Chrome.",
  "url is not on the host list": "That page is outside this session's allowed sites.",
  busy: "Another live session is open. Finish it before starting a new one.",
  not_open: "Start a live session before continuing.",
  credentials: "Bao does not open links that contain sign-in details.",
  scheme: "Bao only opens web pages.",
  "blocked-path": "Bao stopped at a path it does not drive.",
  "signed-out": LIVE_LOGIN_INSTRUCTION,
  "sign in": LIVE_LOGIN_INSTRUCTION,
  "bot check": "Complete the bot check in Chrome, then continue.",
  "element is covered": "Another control covers this one. Clear it in Chrome before continuing.",
  "no identity": "Bao could not find the recorded control.",
  "lookup miss": "Bao could not find the recorded control.",
  "stopped, timed out": "Bao stopped waiting. Check the page before trying again.",
  captcha: "Complete the bot check in Chrome, then continue.",
  cancelled: "The run was canceled.",
  approve: "Review the proposed change before continuing.",
  paused: "The run is waiting for you.",
  timeout: "Bao stopped waiting. Check the page before trying again.",
  "timed-out": "Bao stopped waiting. Check the page before trying again.",
  "below-threshold": "Bao could not find the recorded control with enough certainty.",
  "no-candidates": "Bao could not find the recorded control.",
  tie: "More than one control matched. Choose the right control before continuing.",
  "5xx": "The site is not available. Try again later.",
  unknown: UNKNOWN_STOP,
};

export function ownerStopText(value: string): string {
  const text = value.trim();
  if (/\ballowCommit\b|--allow-commit/.test(text)) return EXPERIAN_COMMIT_MESSAGE;
  const phased = /^(?:find|action|assert|wait_for|auth): (.+)$/.exec(text);
  if (phased) return ownerStopMessage(phased[1]!);
  if (/^5xx(?: \d{3})?$/.test(text)) return STOP_MESSAGES["5xx"]!;
  if (Object.hasOwn(STOP_MESSAGES, text)) return STOP_MESSAGES[text]!;
  return text.replace(/\b[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+\b/g, (code) =>
    Object.hasOwn(STOP_MESSAGES, code) ? STOP_MESSAGES[code]! : code.includes("_") ? UNKNOWN_STOP : code);
}

export function ownerStopMessage(reason: string, ask = ""): string {
  const instruction = ask.trim();
  if (instruction && /\s|[.!?]$/.test(instruction) && ownerStopText(instruction) === instruction) return instruction;
  const message = ownerStopText(reason);
  return /\s|[.!?]$/.test(message) ? message : UNKNOWN_STOP;
}
