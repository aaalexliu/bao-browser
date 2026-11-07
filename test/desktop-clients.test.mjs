import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { approvalDecision, CLAUDE_NOT_CONNECTED, claudeReplyChecks, claudeScenarioPrompt, claudeToolPrompt, composerText, headerChipCandidates, macConnected, ownTaskTab, ownTaskTabFromJson, parseArgs, scenarioPrompt, saysProfileCopyDeleted, selectedComputer, sites, summarizeClaudeRun, summarizeRun, toolProbeAnswer } from '../scripts/test-desktop-clients.mjs';

const script = new URL('../scripts/test-desktop-clients.mjs', import.meta.url);
test('CLI help and invalid arguments do not launch apps or need owner files', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'bao-client-test-'));
  try {
    const env = { ...process.env, HOME: home, BAO_HEAL_CURSOR_ACCOUNT: '0' };
    for (const key of Object.keys(env)) if (/_API_KEY$/.test(key)) delete env[key];
    const help = spawnSync(process.execPath, [script.pathname, '--help'], { env, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Creates real chats and Library runs/);
    assert.match(help.stdout, /--client claude drives claude\.ai/);
    assert.doesNotMatch(help.stdout, /launch Claude Desktop/);
    const bad = spawnSync(process.execPath, [script.pathname, '--output', 'relative'], { env, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /absolute local directory/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('argument parsing limits sites and accepts only the two desktop clients', () => {
  assert.deepEqual(parseArgs(['--output', '/tmp/proof', '--site', 'x.com']), { output: '/tmp/proof', site: 'x.com', client: 'chatgpt' });
  assert.deepEqual(parseArgs(['--output', '/tmp/proof', '--client', 'claude', '--site', 'github.com']), { output: '/tmp/proof', site: 'github.com', client: 'claude' });
  assert.throws(() => parseArgs(['--output', '/tmp/proof', '--client', 'desktop']), /chatgpt or claude/);
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
test('claude prompts stay short, name the browser, and do not approve tools', () => {
  const probe = claudeToolPrompt();
  assert.equal(probe.includes('\n'), false);
  assert.match(probe, /Do not call a tool/);
  assert.equal(probe.includes('Allow once'), false);
  for (const site of sites) for (const browser of ['copy', 'bao']) {
    const prompt = claudeScenarioPrompt({ id: 'example-id', site, browser });
    assert.equal(prompt.includes('\n'), false);
    assert.ok(prompt.length < 900);
    assert.ok(prompt.includes(`browser=${JSON.stringify(browser)}`));
    assert.ok(prompt.includes(JSON.stringify(site.url)));
    assert.match(prompt, /Do not use browser="current"/);
    assert.match(prompt, /Do not click, fill, press/);
    assert.match(prompt, /command="close"/);
    assert.equal(prompt.includes('BAO_E2E_DONE example-id'), false);
    assert.equal(prompt.includes('Always allow'), false);
    assert.equal(prompt.includes('deleted the profile copy'), false);
    if (browser === 'copy') assert.match(prompt, /copied profile is still on disk/);
    else assert.equal(prompt.includes('profile copy'), false);
  }
});

test('claude approval clicks Allow once only when the tool row matches', () => {
  const card = (command, extra = '') => `- button "Always allow" [ref=e1]\n- button "Allow once" [ref=e2]\n- button "Decline" [ref=e3]\nCommand\n${command}\n${extra}`;
  const expected = { url: 'https://github.com/', browser: 'copy' };
  const open = approvalDecision(card('open', 'Args\nhttps://github.com/\nBrowser\ncopy\n'), expected);
  assert.deepEqual(open, { action: 'allow-once', ref: 'e2', command: 'open' });
  assert.equal(open.ref === 'e1', false);
  assert.equal(approvalDecision(card('open', 'Args\nhttps://github.com/\nBrowser\ncurrent\n'), expected).action, 'refuse');
  assert.equal(approvalDecision(card('open', 'Args\nhttps://github.com/\nBrowser\ncopy\n'), { url: 'https://github.com/', browser: 'bao' }).action, 'refuse');
  assert.equal(approvalDecision(card('click', 'Args\n@e9\n'), expected).action, 'refuse');
  assert.deepEqual(approvalDecision(card('close'), { url: 'https://github.com/', browser: 'bao' }), { action: 'allow-once', ref: 'e2', command: 'close' });
  assert.deepEqual(approvalDecision(card('tab', 'Args\nt6\n'), expected), { action: 'allow-once', ref: 'e2', command: 'tab' });
  assert.equal(approvalDecision(card('tab', 'Args\nclose\n'), expected).action, 'refuse');
  assert.equal(approvalDecision('- button "Always allow" [ref=e1]\nCommand\nopen\nArgs\nhttps://github.com/\nBrowser\ncopy\n', expected).action, 'refuse');
  assert.equal(approvalDecision('- button "Always allow" [ref=e1]\nCommand\nopen\n', expected).ref, undefined);
  const named = '- button "Allow once" [ref=e9]\n- text "Command"\n- text "open"\n- text "Args"\n- text "https://github.com/"\n- text "Browser"\n- text "bao"\n';
  assert.deepEqual(approvalDecision(named, { url: 'https://github.com/', browser: 'bao' }), { action: 'allow-once', ref: 'e9', command: 'open' });
});

test('claude stops unless the chat shows the Mac as Connected', () => {
  assert.equal(macConnected('alex-m1 Connected\nClaude can use the files and apps on your computer.'), true);
  assert.equal(macConnected('- button "Connected" [ref=e4]'), true);
  assert.equal(macConnected('- button "Not connected" [ref=e4]'), false);
  assert.equal(macConnected('Connected to Gmail'), false);
  assert.match(CLAUDE_NOT_CONNECTED, /Stopped without a Bao site prompt/);
  assert.equal(CLAUDE_NOT_CONNECTED.includes('connect a device'), false);
  assert.equal(selectedComputer('- menuitemcheckbox "desk-a Selected automatically" [ref=e1]\n- menuitemcheckbox "desk-b Not connected" [ref=e2]'), 'selected');
  assert.equal(selectedComputer('- menuitemcheckbox "desk-a Selected, Not connected" [ref=e1]'), 'not-connected');
  assert.equal(selectedComputer('- menuitemcheckbox "desk-b Not connected" [ref=e1]'), 'missing');
});

test('the task tab is only the active claude.ai tab', () => {
  assert.equal(ownTaskTab('\u001b[36m→\u001b[0m [t21] Claude - https://claude.ai/new\n  [t3] Mail - https://mail.example/inbox'), 't21');
  assert.equal(ownTaskTab('  [t21] Claude - https://claude.ai/new\n→ [t3] Mail - https://mail.example/'), undefined);
  assert.equal(ownTaskTabFromJson('{"data":{"tabs":[{"tabId":"t8","url":"https://claude.ai/new","active":true},{"tabId":"t1","url":"https://mail.example/","active":false}]}}'), 't8');
  assert.equal(ownTaskTabFromJson('{"data":{"tabs":[{"tabId":"t8","url":"https://claude.ai/new","active":false},{"tabId":"t1","url":"https://mail.example/","active":true}]}}'), undefined);
});

test('a claude library run passes only when capture, open and close passed', () => {
  const step = (command, args, status = 'passed') => ({ status, native: { command, args, results: [{ exitCode: status === 'passed' ? 0 : 1 }] } });
  const passed = summarizeClaudeRun({ id: 'run-1', kind: 'capture', status: 'passed', pageEngine: 'agent-browser', steps: [step('open', ['https://github.com/']), step('close', [])] }, 'https://github.com/');
  assert.equal(passed.status, 'captured');
  assert.equal(passed.closed, true);
  assert.equal(passed.runId, 'run-1');
  assert.equal(summarizeClaudeRun({ kind: 'replay', steps: [step('open', ['https://github.com/']), step('close', [])] }, 'https://github.com/').status, 'not_capture');
  assert.equal(summarizeClaudeRun({ kind: 'capture', steps: [step('open', ['https://github.com/'], 'failed'), step('close', [])] }, 'https://github.com/').status, 'open_not_passed');
  assert.equal(summarizeClaudeRun({ kind: 'capture', steps: [step('open', ['https://github.com/']), step('click', ['@e1']), step('close', [])] }, 'https://github.com/').status, 'unexpected_command');
  assert.equal(summarizeClaudeRun(undefined, 'https://github.com/').status, 'missing_run');
});

test('claude reply checks require the marker, the title, and a deleted copy only for copy', () => {
  const site = sites.find(item => item.host === 'github.com');
  const copy = claudeReplyChecks('The page title is GitHub. Bao deleted the profile copy. signed_in BAO_E2E_DONE claude-1', { site, browser: 'copy', id: 'claude-1' });
  assert.deepEqual(copy, { done: true, title: true, copyDeleted: true, outcome: 'signed_in' });
  const missing = claudeReplyChecks('The page title is GitHub. signed_in BAO_E2E_DONE claude-1', { site, browser: 'copy', id: 'claude-1' });
  assert.equal(missing.copyDeleted, false);
  const asked = claudeScenarioPrompt({ id: 'claude-1', site, browser: 'copy' });
  assert.equal(saysProfileCopyDeleted(asked + ' Profile copy deletion: not confirmed. It did not report a deletion.', asked), false);
  assert.equal(saysProfileCopyDeleted(asked + ' Bao deleted the profile copy.', asked), true);
  const bao = claudeReplyChecks('The page title is GitHub. The session closed. signed_in BAO_E2E_DONE claude-2', { site, browser: 'bao', id: 'claude-2' });
  assert.equal(bao.copyDeleted, true);
  const probe = claudeToolPrompt();
  assert.equal(toolProbeAnswer(probe), '');
  assert.equal(toolProbeAnswer(`${probe}\n- StaticText "BAO_TOOLS: yes"`), 'yes');
  assert.equal(toolProbeAnswer(`${probe}\nBAO_TOOLS: no`), 'no');
  assert.equal(toolProbeAnswer('- StaticText "BAO_TOOLS: no"\n- StaticText "BAO_TOOLS: yes"'), 'yes');
  const header = '- button "Show sidebar" [ref=e1]\n- button "Chat tool names" [ref=e2]\n- button [ref=e3]\n- button "Share" [ref=e4]\n- textbox "Reply" [ref=e5]\n- button "Copy" [ref=e6]\n';
  assert.deepEqual(headerChipCandidates(header, new Set(['Show sidebar'])).map(element => element.ref), ['e2', 'e3']);
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
