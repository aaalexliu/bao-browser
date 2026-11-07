import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { composerText, parseArgs, scenarioPrompt, sites, summarizeRun } from '../scripts/test-desktop-clients.mjs';

const script = new URL('../scripts/test-desktop-clients.mjs', import.meta.url);
test('CLI help and invalid arguments do not launch apps or need owner files', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'bao-client-test-'));
  try {
    const env = { ...process.env, HOME: home, BAO_HEAL_CURSOR_ACCOUNT: '0' };
    for (const key of Object.keys(env)) if (/_API_KEY$/.test(key)) delete env[key];
    const help = spawnSync(process.execPath, [script.pathname, '--help'], { env, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Creates real chats and Library runs/);
    const bad = spawnSync(process.execPath, [script.pathname, '--output', 'relative'], { env, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /absolute local directory/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('argument parsing limits sites and rejects unsupported client flags', () => {
  assert.deepEqual(parseArgs(['--output', '/tmp/proof', '--site', 'x.com']), { output: '/tmp/proof', site: 'x.com' });
  assert.throws(() => parseArgs(['--output', '/tmp/proof', '--client', 'claude']), /Unknown/);
  assert.throws(() => parseArgs(['--output', '/tmp/proof', '--site', 'example.com']), /four documented sites/);
});
test('each prompt fixes the browser and prohibits account-changing commands', () => {
  for (const site of sites) for (const browser of ['copy', 'bao']) {
    const prompt = scenarioPrompt({ id: 'example-id', site, browser });
    assert.ok(prompt.includes(`browser=${JSON.stringify(browser)}`));
    assert.ok(prompt.includes(JSON.stringify(site.url)));
    assert.match(prompt, /Do not click, fill, press, post, like, follow, send, buy/);
    assert.match(prompt, /Do not call wait_for_owner/);
    assert.match(prompt, /Always finish with agent_browser command="close"/);
    assert.ok(!prompt.includes('\n'), 'scenario prompts must stay on one line');
    assert.ok(prompt.length < 900, 'scenario prompts must stay short');
    assert.ok(!prompt.includes('BAO_E2E_DONE example-id'), 'the prompt itself must not match the completion marker');
  }
});
test('composer read-back ignores hidden editors and preserves paragraph text exactly', () => {
  const editor = (visible, paragraphs) => ({ getClientRects: () => visible ? [{}] : [], querySelectorAll: () => paragraphs.map(textContent => ({ textContent })) });
  const read = editors => runInNewContext(`(${composerText.toString()})('[contenteditable]')`, { document: { querySelectorAll: () => editors } });
  assert.equal(read([editor(false, ['old draft']), editor(true, ['open https://x.com/home'])]), 'open https://x.com/home');
  assert.equal(read([editor(true, ['first', 'second'])]), 'first\nsecond');
  assert.equal(read([editor(false, ['hidden'])]), null);
  assert.throws(() => read([editor(true, ['a']), editor(true, ['b'])]), /More than one visible/);
});
test('a completed conversation does not turn missing, open or failed runs into a pass', () => {
  const step = (command, status = 'passed', stdout = '', exitCode = 0) => ({ status, native: { command, args: [], results: [{ stdout, exitCode }] } });
  assert.equal(summarizeRun(undefined).status, 'missing_run');
  assert.equal(summarizeRun({ steps: [step('open')] }).status, 'not_closed');
  assert.equal(summarizeRun({ steps: [step('open', 'failed', '', 1), step('close')] }).status, 'command_failed');
  assert.equal(summarizeRun({ steps: [step('open', 'passed', '{"outcome":"halted"}'), step('close')] }).status, 'sign_in_required');
  assert.equal(summarizeRun({ steps: [step('open'), step('close')] }).status, 'incomplete_capture');
  assert.equal(summarizeRun({ steps: [step('open'), step('click'), step('close')] }).status, 'unexpected_command');
  const result = summarizeRun({ id: 'run-test', status: 'passed', steps: [step('open'), step('snapshot'), step('screenshot'), step('close')] });
  assert.equal(result.status, 'captured');
  assert.equal(result.closed, true);
  assert.equal(result.runId, 'run-test');
});
