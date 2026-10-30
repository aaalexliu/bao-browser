// The suite runner clears real heal credentials. This file does not opt in.
// A test that wants a healer sets BAO_HEAL_CURSOR_ACCOUNT or BAO_HEAL_FIXTURE itself.

import assert from "node:assert/strict";
import test from "node:test";
import { cursorAccountHeal, resetCursorAccountCache } from "../../src/v1/cursor-account";

const REAL_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "CURSOR_API_KEY"] as const;

test("the suite cannot reach a logged-in Cursor account or a real model", async () => {
  assert.equal(process.env.BAO_HEAL_CURSOR_ACCOUNT, "0");
  assert.equal(process.env.BAO_HEAL_CURSOR, undefined);
  assert.equal(process.env.BAO_HEAL_CURSOR_RESPONSE, undefined);
  assert.equal(process.env.BAO_HEAL_FIXTURE, undefined);
  assert.equal(process.env.BAO_CURSOR_AGENT, undefined);
  for (const key of REAL_KEYS) assert.equal(process.env[key], undefined, key);
  resetCursorAccountCache();
  const heal = await cursorAccountHeal(process.env);
  assert.equal(heal.available(), false);
});
