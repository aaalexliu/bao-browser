// A sign-in or verification wall drawn inside a page whose URL and title look normal, read from an agent-browser snapshot.

const WORDING = /\b(?:sign[ -]?in|log[ -]?in|confirm your account|verify your (?:identity|account|email)|verification code|one[- ]time (?:code|password|passcode)|two[- ]factor|security code)\b/i;
const SECRET_FIELD = /^- (?:textbox|spinbutton) "(?:[^"]*\b(?:password|passcode|one[- ]time|verification code|security code|otp)\b[^"]*|(?:enter )?(?:the )?code)"/i;
const SEND_CODE = /^- (?:link|button) "[^"]*\b(?:send|email|text|get|request|resend)\b(?: me)?(?: an?| the| my)?(?: new)?(?: one[- ]time| verification| security| login| sign[- ]in)? code\b/i;
const DIALOG = /^- (?:alert)?dialog\b/;
const MAIN_HEADING = /^- heading "([^"]*)" \[[^\]]*\blevel=1\b/;

/**
 * A dialog with sign-in or verification wording and a password field, a code field, or a send-a-code control inside it, or a
 * main heading with that wording and such a control anywhere on the page.
 */
export function pageWall(snapshot: string): boolean {
  const lines = snapshot.split("\n").map((line) => ({ depth: line.length - line.trimStart().length, text: line.trim() }));
  const control = (line: { text: string }) => SECRET_FIELD.test(line.text) || SEND_CODE.test(line.text);
  return lines.some((line, index) => {
    if (DIALOG.test(line.text)) {
      const end = lines.findIndex((next, at) => at > index && next.text && next.depth <= line.depth);
      const inside = lines.slice(index, end === -1 ? undefined : end);
      return inside.some((entry) => WORDING.test(entry.text)) && inside.some(control);
    }
    const heading = MAIN_HEADING.exec(line.text);
    return !!heading && WORDING.test(heading[1]!) && lines.some(control);
  });
}
