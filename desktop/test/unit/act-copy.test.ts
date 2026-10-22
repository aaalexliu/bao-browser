import assert from "node:assert/strict";
import test from "node:test";
import { actNotice } from "../../src/app/capture";
import { actAskLine, actDeadlineLine, actSurfaceText, makeAsk, siteHost } from "../../src/v1/human-ask";
import { formatClock } from "../../src/v1/time";

const AT = Date.parse("2026-10-22T04:50:16.442Z");

test("the act sentence names the site and the notification matches the tooltip", () => {
  assert.equal(siteHost("https://example.com/login?next=/home"), "example.com");
  assert.equal(siteHost("not a url"), "the site");
  const login = makeAsk({
    kind: "login",
    workflowId: "wf",
    workflowName: "Fixture login",
    stepId: "login",
    stepIndex: 1,
    stepCount: 1,
    label: "sign in",
    site: "example.com",
    timeoutMs: 60 * 60 * 1000,
    now: AT,
  });
  assert.equal(login.instruction, "Sign in to example.com in the Bao window");
  assert.equal(actAskLine(login), login.instruction);
  const until = actDeadlineLine(login.deadline, AT);
  assert.equal(until, `Waiting 60:00 · times out at ${formatClock(login.deadline!)}`);
  assert.match(until, /(UTC|GMT|EDT|EST|CDT|CST|MDT|MST|PDT|PST)/);
  const text = actSurfaceText(login, AT);
  assert.equal(text, `${login.instruction}. ${until}`);
  const notice = actNotice(text);
  assert.equal(notice.title, text);
  assert.equal(notice.body, text);
  assert.equal(notice.tooltip, text);
  assert.equal(notice.badge, "!");

  const confirm = makeAsk({
    kind: "confirm",
    workflowId: "wf",
    workflowName: "Fixture login",
    stepId: "apply",
    stepIndex: 2,
    stepCount: 2,
    label: 'you press "Apply"',
    button: "Apply",
    site: "example.com",
    timeoutMs: 1000,
    now: AT,
  });
  assert.equal(actAskLine(confirm), "Press Apply on example.com in the Bao window");
});
