#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const baoURL = 'http://127.0.0.1:4787';
const chrome = '/Applications/Bao.app/Contents/Resources/Chromium.app/Contents/MacOS/Google Chrome for Testing';
export const sites = [
  { host: 'x.com', url: 'https://x.com/home', read: 'the account name and up to three feed headings' },
  { host: 'github.com', url: 'https://github.com/', read: 'the account name and up to three dashboard headings' },
  { host: 'mail.google.com', url: 'https://mail.google.com/mail/u/0/#inbox', read: 'the account name and up to three inbox subject lines; do not open messages' },
  { host: 'linkedin.com', url: 'https://www.linkedin.com/feed/', read: 'the account name and up to three feed headings' },
];
const client = { app: '/Applications/ChatGPT.app', executable: 'ChatGPT', target: 'app://-/index.html', composer: '[contenteditable="true"][role="textbox"]' };

export function parseArgs(args) {
  const options = { output: '', site: '', client: 'chatgpt' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') return { help: true };
    if (!['--output', '--site', '--client'].includes(key) || !args[i + 1]) throw new Error(`Unknown or incomplete argument: ${key}`);
    options[key.slice(2)] = args[++i];
  }
  if (!path.isAbsolute(options.output)) throw new Error('--output must be an absolute local directory outside the checkout');
  if (options.site && !sites.some(site => site.host === options.site)) throw new Error('--site must name one of the four documented sites');
  if (!['chatgpt', 'claude'].includes(options.client)) throw new Error('--client must be chatgpt or claude');
  return options;
}

export function scenarioPrompt({ id, site, browser }) {
  return `Read-only Bao test ${id}. Use only Bao MCP agent_browser, not shell or other browser tools. Close any prior session. Call open args=[${JSON.stringify(site.url)}] browser=${JSON.stringify(browser)} explicitly; then snapshot and screenshot. Read ${site.read}. Do not click, fill, press, post, like, follow, send, buy, change settings or enter credentials. Do not call wait_for_owner or retry. On error/sign-in, record blocked/sign_in_required. Always finish with agent_browser command="close". Report signed_in/sign_in_required/blocked, reason and run ID. End with BAO_E2E_DONE, a space, then this test's identifier.`;
}

export function summarizeRun(run) {
  if (!run) return { status: 'missing_run', commands: [] };
  const commands = (run.steps || []).map(step => ({ command: step.native?.command, args: step.native?.args, status: step.status, error: step.native?.error || step.native?.results?.find(result => result.exitCode !== 0)?.stderr?.slice(0, 500) || step.reason, exitCodes: (step.native?.results || []).map(result => result.exitCode) }));
  const ownerWait = (run.steps || []).some(step => (step.native?.results || []).some(result => /"outcome"\s*:\s*"(?:halted|waiting)"/.test(result.stdout)));
  const closed = commands.at(-1)?.command === 'close' && commands.at(-1)?.status === 'passed';
  const failed = commands.some(command => command.status === 'failed' || command.exitCodes.some(code => code !== 0));
  const unexpected = commands.some(command => !['open', 'snapshot', 'screenshot', 'tab', 'close'].includes(command.command));
  const complete = ['open', 'snapshot', 'screenshot', 'close'].every(name => commands.some(command => command.command === name));
  return { status: unexpected ? 'unexpected_command' : ownerWait ? 'sign_in_required' : !closed ? 'not_closed' : failed ? 'command_failed' : !complete ? 'incomplete_capture' : 'captured', runId: run.id, runStatus: run.status, closed, commands };
}

const installedMcp = '/Applications/Bao.app/Contents/MacOS/bao-mcp';
const claudeChat = 'https://claude.ai/new';
export const CLAUDE_NOT_CONNECTED = 'claude.ai does not show the Mac as Connected. Stopped without a Bao site prompt, connecting a device, or changing Claude settings.';

export function claudeToolPrompt() {
  return 'If remote-devices bao and agent_browser are available, reply with the single line BAO_TOOLS: yes. Otherwise reply with the single line BAO_TOOLS: no. Do not call a tool. Do not browse.';
}

export function claudeScenarioPrompt({ id, site, browser }) {
  const closeNote = browser === 'copy' ? ' After close, say whether that copied profile is still on disk.' : ' After close, say the session closed.';
  return `Read-only Bao test ${id}. Use only Bao agent_browser. Call open args=[${JSON.stringify(site.url)}] browser=${JSON.stringify(browser)} explicitly, then snapshot and screenshot. Read ${site.read}. Say the page title. Do not use browser="current". Do not click, fill, press, post, like, follow, send, buy, change settings, or enter credentials. Do not call wait_for_owner. On error or sign-in, record blocked or sign_in_required. Always finish with agent_browser command="close".${closeNote} Report signed_in, sign_in_required, or blocked, the reason, and the run ID. End with BAO_E2E_DONE, a space, then this test's identifier.`;
}

export function snapshotElements(text) {
  const elements = [];
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^\s*-\s+([A-Za-z][\w-]*)(?:\s+"((?:\\.|[^"\\])*)")?(.*)$/);
    if (!match) continue;
    elements.push({ role: match[1], name: (match[2] || '').replace(/\\"/g, '"'), ref: match[3].match(/ref=(e\d+)/)?.[1], value: match[3].match(/:\s*(.*)$/)?.[1] });
  }
  return elements;
}

export function macConnected(snapshot) {
  const flat = String(snapshot || '').replace(/\s+/g, ' ');
  if (/\bConnected\b/.test(flat) && /files and apps on your computer/.test(flat)) return true;
  return snapshotElements(snapshot).some(element => element.role === 'button' && (element.name === 'Connected' || /\bConnected\b/.test(element.name) && /computer|device|Mac|files and apps/i.test(element.name)));
}

export function deviceChipRef(snapshot) {
  const buttons = snapshotElements(snapshot).filter(element => element.role === 'button' && element.ref);
  return buttons.find(element => element.name === 'Connected' || /\bConnected\b/.test(element.name) && /computer|device|Mac/i.test(element.name))?.ref
    || buttons.find(element => /\b(device|computer)\b/i.test(element.name) && !/manage devices/i.test(element.name))?.ref;
}

export function composerRef(snapshot) {
  const boxes = snapshotElements(snapshot).filter(element => element.role === 'textbox' && element.ref);
  const named = boxes.filter(element => /reply|message|claude|ask|help/i.test(element.name || ''));
  const pool = named.length ? named : boxes;
  return pool.at(-1)?.ref;
}

export function composerHolds(snapshot, prompt) {
  return snapshotElements(snapshot).some(element => element.role === 'textbox' && (element.value === prompt || element.name === prompt || (element.value || '').includes(prompt)));
}

export function sendRef(snapshot) {
  const matches = snapshotElements(snapshot).filter(element => element.role === 'button' && element.ref && /^send( message)?$/i.test(element.name || ''));
  return matches.length === 1 ? matches[0].ref : undefined;
}

export function needsInputRef(snapshot) {
  const matches = snapshotElements(snapshot).filter(element => element.role === 'button' && element.ref && element.name === 'Needs your input');
  return matches.length === 1 ? matches[0].ref : undefined;
}

export function stillGenerating(snapshot) {
  return snapshotElements(snapshot).some(element => element.role === 'button' && /^Stop\b/.test(element.name || ''));
}

export function claudeSignInWall(snapshot) {
  if (composerRef(snapshot)) return false;
  return snapshotElements(snapshot).some(element => element.role === 'button' && /^(sign in|log in|continue with google)$/i.test(element.name || ''));
}

export function allowOnceRef(snapshot) {
  const matches = snapshotElements(snapshot).filter(element => element.role === 'button' && element.ref && element.name === 'Allow once');
  return matches.length === 1 ? matches[0].ref : undefined;
}

function cardWindow(snapshot) {
  const start = String(snapshot || '').lastIndexOf('Command');
  return start < 0 ? '' : snapshot.slice(start, start + 800).replace(/\s+/g, ' ');
}

function normalizeArg(value) {
  return String(value || '').trim().replace(/^[\["']+/, '').replace(/[\]"']+$/, '');
}

function sameUrl(actual, expected) {
  try {
    const left = new URL(normalizeArg(actual));
    const right = new URL(expected);
    return left.origin === right.origin && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '');
  } catch { return normalizeArg(actual) === expected; }
}

function toolCard(snapshot) {
  const names = snapshotElements(snapshot).map(element => element.name).filter(Boolean);
  const fields = {};
  for (let i = 0; i < names.length - 1; i++) {
    if (names[i] === 'Command' || names[i] === 'Args' || names[i] === 'Browser') fields[names[i].toLowerCase()] = names[i + 1];
  }
  const flat = cardWindow(snapshot);
  if (!fields.command) fields.command = flat.match(/\bCommand\s+([A-Za-z_]+)/)?.[1];
  if (!fields.args) fields.args = flat.match(/\bArgs\s+(https?:\/\/\S+|t\d+)/)?.[1];
  if (!fields.browser) fields.browser = flat.match(/\bBrowser\s+(copy|bao|current)\b/)?.[1];
  return fields;
}

export function approvalDecision(snapshot, expected) {
  const ref = allowOnceRef(snapshot);
  const always = snapshotElements(snapshot).some(element => element.role === 'button' && element.name === 'Always allow');
  if (!ref) return always && toolCard(snapshot).command ? { action: 'refuse', reason: 'Allow once is missing' } : { action: 'wait' };
  const { command, args, browser } = toolCard(snapshot);
  const refuse = reason => ({ action: 'refuse', reason });
  if (!command) return refuse('tool row has no Command');
  if (command === 'open') {
    if (!sameUrl(args, expected.url)) return refuse('open URL does not match');
    if (browser !== expected.browser) return refuse('open browser does not match');
  } else if (command === 'tab') {
    if (!/^t\d+$/.test(normalizeArg(args))) return refuse('refusing tab command');
  } else if (!['snapshot', 'screenshot', 'close'].includes(command)) return refuse(`refusing ${command}`);
  else if (browser && browser !== expected.browser) return refuse('browser does not match');
  return { action: 'allow-once', ref, command };
}

export function ownTaskTab(text) {
  const plain = String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
  const tabs = [];
  for (const line of plain.split('\n')) {
    const parsed = line.match(/^(.*)\[(t\d+)\]\s+(.*)$/);
    if (!parsed) continue;
    const rest = parsed[3].trim();
    const split = rest.lastIndexOf(' - ');
    if (split < 0) continue;
    tabs.push({ active: parsed[1].includes('→'), id: parsed[2], url: rest.slice(split + 3).trim() });
  }
  const active = tabs.find(tab => tab.active);
  if (!active || !/^t\d+$/.test(active.id)) return undefined;
  try {
    const host = new URL(active.url).hostname;
    return host === 'claude.ai' || host.endsWith('.claude.ai') ? active.id : undefined;
  } catch { return undefined; }
}

export function ownTaskTabFromJson(text) {
  for (const line of String(text || '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let body;
    try { body = JSON.parse(line); } catch { continue; }
    const tabs = body?.data?.tabs || body?.tabs;
    if (!Array.isArray(tabs)) continue;
    const active = tabs.find(tab => tab.active);
    const id = active?.tabId || active?.id;
    if (!/^t\d+$/.test(id || '')) continue;
    try {
      const host = new URL(active.url || '').hostname;
      if (host === 'claude.ai' || host.endsWith('.claude.ai')) return id;
    } catch { continue; }
  }
  return undefined;
}

export function saysProfileCopyDeleted(text, prompt = '') {
  const body = String(text || '').replace(prompt, '');
  return /deleted the profile copy|profile copy (?:was|has been) deleted|removed the copied profile/i.test(body);
}

export function claudeReplyChecks(text, { site, browser, id }) {
  const body = String(text || '');
  return {
    done: body.includes(`BAO_E2E_DONE ${id}`),
    title: site.host === 'github.com' ? /\bGitHub\b/.test(body) : body.includes(site.host),
    copyDeleted: browser !== 'copy' || saysProfileCopyDeleted(body, claudeScenarioPrompt({ id, site, browser })),
    outcome: [...body.matchAll(/\b(signed_in|sign_in_required|blocked)\b/g)].at(-1)?.[1] || 'not_reported',
  };
}

export function toolProbeAnswer(text) {
  const answers = [];
  for (const element of snapshotElements(text)) {
    const match = element.name.match(/^BAO_TOOLS:\s*(yes|no)\b/i);
    if (match) answers.push(match[1].toLowerCase());
  }
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^\s*(?:-\s+\w+\s+")?BAO_TOOLS:\s*(yes|no)\b/i);
    if (match) answers.push(match[1].toLowerCase());
  }
  return answers.at(-1) || '';
}

export function summarizeClaudeRun(run, url) {
  if (!run) return { status: 'missing_run', commands: [], closed: false };
  const commands = (run.steps || []).map(step => ({ command: step.native?.command, args: step.native?.args, status: step.status, exitCodes: (step.native?.results || []).map(result => result.exitCode) }));
  const openPassed = commands.some(command => command.command === 'open' && command.args?.[0] === url && command.status === 'passed' && command.exitCodes.every(code => code === 0));
  const close = [...commands].reverse().find(command => command.command === 'close');
  const closed = Boolean(close && close.status === 'passed' && close.exitCodes.every(code => code === 0));
  const unexpected = commands.some(command => !['open', 'snapshot', 'screenshot', 'tab', 'close'].includes(command.command));
  const status = run.kind !== 'capture' ? 'not_capture' : unexpected ? 'unexpected_command' : !openPassed ? 'open_not_passed' : !closed ? 'not_closed' : 'captured';
  return { status, runId: run.id, runStatus: run.status, kind: run.kind, pageEngine: run.pageEngine, closed, commands };
}

async function jsonFile(file, value) { await writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
async function api(route, body) {
  const response = await fetch(baoURL + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) } : { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Bao ${route}: HTTP ${response.status}`);
  return response.json();
}
function session(name, extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CHROME_DEVTOOLS_AXI_')) delete env[key];
  Object.assign(env, { CHROME_DEVTOOLS_AXI_SESSION: name, ...extra });
  return async (command, args = [], input) => {
    const child = execFile('chrome-devtools-axi', [command, ...args], { env, timeout: 45000, maxBuffer: 8 * 1024 * 1024 }, () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    return await new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`chrome-devtools-axi ${command}: ${stderr || stdout || code}`)));
    });
  };
}
async function evaluate(axi, fn) { return JSON.parse(await axi('run', [], `console.log(JSON.stringify(await page.eval(${fn})));`)); }
async function capture(axi, directory, name) {
  await writeFile(path.join(directory, `${name}.txt`), await axi('snapshot'));
  await axi('screenshot', [path.join(directory, `${name}.jpeg`), '--format', 'jpeg']);
}
async function baoBrowserProcesses() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,command=']);
  return stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome .*--user-data-dir=(.+?)(?= --|$)/.exec(line);
    if (!match || !/\/bao-profile-copies-[^/]+\/run-|\/agent-browser-profile(?:\s|$)/.test(match[2])) return [];
    return [{ pid: Number(match[1]), userDataDir: match[2] }];
  });
}
async function mainPid(client) {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,comm=']);
  const exact = `${client.app}/Contents/MacOS/${client.executable}`;
  const row = stdout.split('\n').find(line => line.trim().replace(/^\d+\s+/, '') === exact);
  return row ? Number(row.trim().split(/\s+/)[0]) : undefined;
}
async function waitUntil(check, milliseconds, message) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await check()) return; await sleep(500); }
  throw new Error(message);
}
async function terminate(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  await waitUntil(async () => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 15000, `App PID ${pid} did not exit after SIGTERM`);
  await sleep(2000);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function checkRegistration() {
  const config = await readFile(path.join(homedir(), '.codex/config.toml'), 'utf8');
  const block = config.split(/(?=^\[)/m).find(block => /^\[mcp_servers\.(?:bao|"bao")\]/.test(block));
  if (!block || !/^command\s*=\s*"\/Applications\/Bao\.app\/Contents\/MacOS\/bao-mcp"\s*$/m.test(block)) throw new Error('ChatGPT Bao MCP registration does not point to the installed launcher');
}
async function cookieHosts(directory) {
  const root = path.join(homedir(), 'Library/Application Support/Google/Chrome');
  const { stdout } = await exec('/usr/bin/sqlite3', ['-readonly', path.join(root, directory, 'Cookies'), 'SELECT DISTINCT host_key FROM cookies ORDER BY host_key;']);
  return stdout.trim().split('\n');
}
export function composerText(selector) {
  const visible = [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length);
  if (visible.length > 1) throw new Error('More than one visible client composer');
  return visible.length ? [...visible[0].querySelectorAll('p')].map(paragraph => paragraph.textContent).join('\n') : null;
}
async function readComposer(axi, selector) {
  return evaluate(axi, `() => (${composerText.toString()})(${JSON.stringify(selector)})`);
}
async function newChat(axi, client) {
  await axi('run', [], `await page.click('button[aria-label="New chat"]');`);
  await waitUntil(async () => (await readComposer(axi, client.composer)) !== null, 15000, 'New-chat composer did not appear');
}
async function typeInClient(axi, selector, text, beforeSend) {
  await evaluate(axi, `() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length); if (!e) throw new Error('Visible client composer missing'); e.focus(); const range = document.createRange(); range.selectNodeContents(e); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return true; }`);
  await axi('type', [text]);
  const actual = await readComposer(axi, selector);
  if (actual !== text) {
    await axi('press', ['Meta+A']);
    await axi('press', ['Backspace']);
    throw new Error(`Composer text differs from the exact prompt; cleared it without sending (expected ${text.length} chars, read ${actual?.length ?? 'no visible composer'})`);
  }
  console.log('Client composer matches the exact text');
  if (beforeSend) {
    await beforeSend();
    await axi('press', ['Enter']);
  }
}
async function clientState(axi) {
  return evaluate(axi, `() => ({text: [...document.querySelectorAll('main')].map(e => e.innerText).join('\\n'), buttons: [...document.querySelectorAll('button')].filter(e => e.getClientRects().length).map(e => ({text:e.innerText,label:e.getAttribute('aria-label'),disabled:e.disabled})), url:location.href})`);
}
async function receiptEvidence(ui, directory, run) {
  await jsonFile(path.join(directory, 'run.json'), run);
  await jsonFile(path.join(directory, 'receipt.json'), await api(`/api/runs/${encodeURIComponent(run.id)}/receipt`));
  await api('/api/open', { link: `bao://receipt/${run.id}` });
  await ui('open', [baoURL]);
  await waitUntil(async () => evaluate(ui, `() => Boolean(document.querySelector('[data-open-run="${run.id}"][aria-current="true"]') && document.querySelector('#run-receipt'))`), 15000, 'Bao receipt did not select the requested run');
  await capture(ui, directory, 'bao-receipt');
  const step = [...run.steps].reverse().find(step => step.afterShot);
  if (step) {
    const response = await fetch(`${baoURL}/api/runs/${encodeURIComponent(run.id)}/shots/${encodeURIComponent(step.afterShot)}`);
    if (!response.ok) throw new Error('Stored Bao site picture is unavailable');
    await writeFile(path.join(directory, 'site-picture.' + path.extname(step.afterShot).slice(1)), Buffer.from(await response.arrayBuffer()));
  }
}
async function gallery(output, results, clientName = 'chatgpt') {
  const sections = [];
  for (const result of results) {
    const files = await readdir(path.join(output, result.id));
    const pictures = ['client-before.jpeg', ...files.filter(file => /^client-tool-(open|snapshot|screenshot|close)\.jpeg$/.test(file)), 'client-after.jpeg', 'bao-receipt.jpeg', ...files.filter(file => /^site-picture\.(png|jpg|jpeg)$/.test(file))].filter(file => files.includes(file));
    sections.push(`<section><h2>${result.site} / ${result.browser}: ${result.status}</h2><p><a href="${result.id}/result.json">JSON result</a></p>${pictures.map(file => `<h3>${file}</h3><img src="${result.id}/${file}" alt="${result.site} ${result.browser} ${file}" loading="lazy">`).join('')}</section>`);
  }
  const claude = clientName === 'claude';
  let probe = '';
  if (claude) {
    try {
      await access(path.join(output, 'tool-probe', 'reply.jpeg'));
      probe = '<section><h2>Tool names</h2><p><a href="tool-probe/prompt.txt">Prompt</a></p><img src="tool-probe/reply.jpeg" alt="claude.ai tool name reply" loading="lazy"></section>';
    } catch {}
  }
  const title = claude ? 'Bao through claude.ai' : 'Bao in ChatGPT desktop';
  const note = claude
    ? 'Local evidence from claude.ai and the connected Mac. Bao shows as plain tool rows, not a picture card. A captured run does not prove a working sign-in. Read each result and inspect each picture.'
    : 'Local evidence. Captured commands do not by themselves prove a working sign-in. Read each result and inspect each picture. Claude Desktop is not covered.';
  await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><style>html{background:#fff;color:#161616;font:16px/1.5 system-ui}body{max-width:1440px;margin:32px auto;padding:0 24px}img{display:block;width:100%;height:auto}section{margin:48px 0}h3{font-size:16px}</style><h1>${title}</h1><p>${note}</p>${probe}${sections.join('')}</html>\n`);
}
async function runScenario(axi, ui, client, scenario, output) {
  const directory = path.join(output, scenario.id);
  await mkdir(directory);
  const before = new Set((await api('/api/state')).runs.map(run => run.id));
  const existingBrowsers = new Set((await baoBrowserProcesses()).map(browser => browser.pid));
  const observedBrowsers = new Map();
  const result = { id: scenario.id, client: scenario.client, site: scenario.site.host, browser: scenario.browser, startedAt: new Date().toISOString(), status: 'started', toolPictures: [] };
  await writeFile(path.join(directory, 'prompt.txt'), scenarioPrompt(scenario));
  await jsonFile(path.join(directory, 'result.json'), result);
  console.log(`${scenario.id}: opening new chat`);
  await newChat(axi, client);
  console.log(`${scenario.id}: filling read-only prompt`);
  await typeInClient(axi, client.composer, scenarioPrompt(scenario), () => capture(axi, directory, 'client-before'));
  console.log(`${scenario.id}: prompt sent; waiting for Bao and final answer`);
  const deadline = Date.now() + 360000;
  let state;
  while (Date.now() < deadline) {
    await sleep(3000);
    state = await clientState(axi);
    for (const browser of await baoBrowserProcesses()) if (!existingBrowsers.has(browser.pid)) observedBrowsers.set(browser.pid, browser);
    const live = (await api('/api/state')).runs.find(run => !before.has(run.id) && run.steps?.some(step => step.native?.command === 'open' && step.native?.args?.[0] === scenario.site.url));
    const step = live?.steps?.at(-1);
    const command = step?.native?.command;
    if (!result.toolPictureError && step?.status === 'passed' && ['open', 'snapshot', 'screenshot'].includes(command) && !result.toolPictures.some(picture => picture.command === command)) {
      try {
        await capture(axi, directory, `client-tool-${command}`);
        result.toolPictures.push({ command, runId: live.id, at: new Date().toISOString(), file: `client-tool-${command}.jpeg` });
      } catch (error) { result.toolPictureError = error.message; }
    }
    const running = state.buttons.some(button => /^(Stop|Stop generating|Stop response)$/.test(button.label || button.text));
    if (state.text.includes(`BAO_E2E_DONE ${scenario.id}`) && !running) break;
  }
  result.completed = Boolean(state?.text.includes(`BAO_E2E_DONE ${scenario.id}`));
  result.conversationURL = state?.url;
  const finalText = state?.text.slice(0, state.text.lastIndexOf(`BAO_E2E_DONE ${scenario.id}`)).slice(-1500) || '';
  result.clientReportedOutcome = [...finalText.matchAll(/\b(signed_in|sign_in_required|blocked)\b/g)].at(-1)?.[1] || 'not_reported';
  result.browserProcesses = [...observedBrowsers.values()];
  result.observedBrowser = result.browserProcesses.some(browser => browser.userDataDir.endsWith('/agent-browser-profile')) ? 'bao' : result.browserProcesses.length ? 'copy' : 'not_observed';
  await writeFile(path.join(directory, 'conversation.txt'), state?.text || 'No conversation text');
  await capture(axi, directory, 'client-after');
  const runs = (await api('/api/state')).runs.filter(run => !before.has(run.id) && run.steps?.some(step => step.native?.command === 'open' && step.native?.args?.[0] === scenario.site.url));
  if (runs.length > 1) throw new Error(`Ambiguous scenario: ${runs.length} matching Bao runs`);
  const run = runs[0] ? await api(`/api/runs/${encodeURIComponent(runs[0].id)}`) : undefined;
  Object.assign(result, summarizeRun(run));
  const remaining = new Set((await baoBrowserProcesses()).map(browser => browser.pid));
  result.browserProcessesClosed = result.browserProcesses.every(browser => !remaining.has(browser.pid));
  if (result.observedBrowser !== 'not_observed' && result.observedBrowser !== scenario.browser) result.status = 'wrong_browser';
  if (!result.browserProcessesClosed) result.status = 'browser_not_closed';
  if (result.toolPictureError && result.status === 'captured') result.status = 'evidence_error';
  if (!result.completed) result.status = 'client_timeout';
  result.finishedAt = new Date().toISOString();
  await jsonFile(path.join(directory, 'result.json'), result);
  if (run) await receiptEvidence(ui, directory, run);
  console.log(`${scenario.id}: ${result.status}${result.runId ? ` (${result.runId})` : ''}`);
  if (!result.completed || !run || !result.closed || !result.browserProcessesClosed || result.status === 'unexpected_command') throw new Error('Scenario did not finish read-only and close; stop before starting another browser');
  return result;
}

function startInstalledMcp() {
  const env = { ...process.env, BAO_HEAL_CURSOR_ACCOUNT: '0' };
  for (const key of ['BAO_HOME', 'BAO_TEST_BROWSER', 'BAO_AGENT_BROWSER', 'BAO_AGENT_BROWSER_PROFILE_ROOT']) delete env[key];
  const child = spawn(installedMcp, [], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let buf = '';
  const pending = new Map();
  let next = 1;
  let exited = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id == null || !pending.has(msg.id)) continue;
      const waiter = pending.get(msg.id);
      clearTimeout(waiter.timer);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error('bao-mcp request failed'));
      else waiter.resolve({ text: (msg.result?.content || []).filter(item => item.type === 'text').map(item => item.text || '').join('\n'), isError: !!msg.result?.isError });
    }
  });
  child.on('exit', code => {
    exited = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`bao-mcp exited ${code}`));
    }
    pending.clear();
  });
  function request(method, params, timeoutMs) {
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`bao-mcp timed out on ${method}`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return {
    runId: undefined,
    async handshake() {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bao-desktop-clients', version: '0' } }, 20000);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    call: (name, args, timeoutMs = 45000) => request('tools/call', { name, arguments: args }, timeoutMs),
    async stop() {
      try { child.stdin.end(); } catch {}
      await new Promise(resolve => {
        if (exited) return resolve();
        const timer = setTimeout(() => { if (!exited) child.kill('SIGTERM'); resolve(); }, 5000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

function namedRun(text) {
  return String(text || '').split('\n').map(line => /^Run (\S+)(?: · \w+)?$/.exec(line)?.[1]).find(Boolean);
}

async function agentCall(mcp, command, args, options = {}) {
  const params = { command, args: args || [] };
  if (options.browser) params.browser = options.browser;
  if (mcp.runId && !(command === 'open' && options.newTask)) params.run_id = mcp.runId;
  const result = await mcp.call('agent_browser', params, options.timeoutMs || (command === 'open' ? 120000 : 45000));
  const named = namedRun(result.text);
  if (named) mcp.runId = named;
  if (command === 'close' && !result.isError) mcp.runId = undefined;
  return result;
}

async function browserCall(mcp, command, args, browserName, timeoutMs, newTask = false) {
  const result = await agentCall(mcp, command, args, { browser: browserName, timeoutMs, newTask });
  if (result.isError) throw new Error(`agent_browser ${command} failed`);
  return result;
}

async function pageSnapshot(mcp) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await agentCall(mcp, 'snapshot', [], { timeoutMs: 45000 });
    if (!result.isError) return result.text;
    await sleep(500);
  }
  throw new Error('claude.ai snapshot failed');
}

async function saveShot(mcp, file) {
  await mkdir(path.dirname(file), { recursive: true });
  await browserCall(mcp, 'screenshot', ['--screenshot-format', 'jpeg', file], undefined, 30000);
  const bytes = await readFile(file).catch(() => Buffer.alloc(0));
  if (bytes.length <= 1000) throw new Error('claude.ai screenshot is missing');
}

async function clickRef(mcp, ref) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await agentCall(mcp, 'click', [`@${ref}`], { timeoutMs: 30000 });
    if (!result.isError && !/stale|ambiguous|not found|covered by/i.test(result.text)) return;
    await sleep(400);
  }
  throw new Error('click missed; took a fresh snapshot');
}

async function taskTabId(mcp, openText) {
  const direct = ownTaskTab(openText) || ownTaskTabFromJson(openText);
  if (direct) return direct;
  const listed = await browserCall(mcp, 'tab', ['list', '--json'], undefined, 20000);
  return ownTaskTab(listed.text) || ownTaskTabFromJson(listed.text);
}

async function waitForChat(mcp) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const snapshot = await pageSnapshot(mcp).catch(() => '');
    if (!snapshot) { await sleep(1000); continue; }
    if (claudeSignInWall(snapshot)) throw new Error('claude.ai is not signed in. Stopped without entering credentials.');
    if (composerRef(snapshot)) return snapshot;
    await sleep(1000);
  }
  throw new Error('claude.ai chat did not appear. Stopped without sending a prompt.');
}

export function selectedComputer(snapshot) {
  const selected = snapshotElements(snapshot).find(element => element.role === 'menuitemcheckbox' && /\bSelected\b/.test(element.name || ''));
  if (!selected) return 'missing';
  return /Not connected/.test(selected.name) ? 'not-connected' : 'selected';
}

function controlRef(snapshot, role, name) {
  return snapshotElements(snapshot).find(element => element.role === role && element.ref && element.name === name && element.name !== 'Always allow')?.ref;
}

async function dismissMenus(mcp) {
  await agentCall(mcp, 'press', ['Escape'], { timeoutMs: 10000 }).catch(() => undefined);
  await agentCall(mcp, 'press', ['Escape'], { timeoutMs: 10000 }).catch(() => undefined);
}

const headerSkip = /Allow|Decline|Stop|Send|sidebar|Project|Model|Manual|Dictate|Microphone|voice|incognito|Add files|Upload|Share|Copy|Retry|Edit|Like|Dislike|Reply|Manage devices|Manage computers/i;

export function headerChipCandidates(snapshot, beforeNames) {
  const elements = snapshotElements(snapshot);
  const composer = elements.findIndex(element => element.role === 'textbox');
  const header = elements.slice(0, composer < 0 ? elements.length : composer);
  const buttons = header.filter(element => element.role === 'button' && element.ref && !headerSkip.test(element.name || ''));
  const afterTitle = [];
  for (let i = 0; i < buttons.length - 1; i++) {
    if (buttons[i].name && !beforeNames.has(buttons[i].name) && buttons[i].name.length > 8 && !buttons[i + 1].name) afterTitle.push(buttons[i + 1]);
  }
  const fresh = buttons.filter(element => !beforeNames.has(element.name));
  const seen = new Set();
  return [...fresh, ...afterTitle].filter(element => !seen.has(element.ref) && seen.add(element.ref)).slice(0, 4);
}

async function deviceMenuState(mcp, output) {
  let snapshot = await pageSnapshot(mcp);
  if (macConnected(snapshot)) return 'connected';
  const add = controlRef(snapshot, 'button', 'Add files, connectors, and more');
  if (!add) return 'missing';
  await clickRef(mcp, add);
  snapshot = await pageSnapshot(mcp);
  const devices = controlRef(snapshot, 'menuitem', 'Devices');
  if (!devices) { await dismissMenus(mcp); return 'missing'; }
  await clickRef(mcp, devices);
  snapshot = await pageSnapshot(mcp);
  const rows = snapshotElements(snapshot).filter(element => element.role === 'menuitemcheckbox').map(element => element.name || '');
  await writeFile(path.join(output, 'device-rows.txt'), rows.join('\n') + '\n');
  const state = macConnected(snapshot) ? 'connected' : selectedComputer(snapshot);
  await dismissMenus(mcp);
  return state;
}

async function confirmChatChip(mcp, beforeNames, tried) {
  const snapshot = await pageSnapshot(mcp);
  if (macConnected(snapshot)) return true;
  const candidate = headerChipCandidates(snapshot, beforeNames).find(element => !tried.has(element.name || `unnamed:${element.ref}`));
  if (!candidate) return false;
  tried.add(candidate.name || `unnamed:${candidate.ref}`);
  await clickRef(mcp, candidate.ref);
  await sleep(600);
  const opened = await pageSnapshot(mcp);
  const connected = macConnected(opened);
  await dismissMenus(mcp);
  return connected;
}

async function confirmAnyChip(mcp, beforeNames, tried) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await confirmChatChip(mcp, beforeNames, tried)) return true;
  }
  return false;
}

async function sendPrompt(mcp, prompt, shotFile) {
  const before = await pageSnapshot(mcp);
  const ref = composerRef(before);
  if (!ref) throw new Error('claude.ai composer is missing');
  const filled = await agentCall(mcp, 'fill', [`@${ref}`, prompt], { timeoutMs: 30000 });
  if (filled.isError) throw new Error('Could not fill the claude.ai composer');
  const readBack = await pageSnapshot(mcp);
  if (!readBack.includes(prompt) || !composerHolds(readBack, prompt)) {
    const current = composerRef(readBack) || ref;
    await agentCall(mcp, 'fill', [`@${current}`, ''], { timeoutMs: 15000 }).catch(() => undefined);
    throw new Error('Composer text differs from the exact prompt; cleared it without sending');
  }
  if (shotFile) await saveShot(mcp, shotFile);
  const send = sendRef(readBack);
  if (send) await clickRef(mcp, send);
  else {
    const pressed = await agentCall(mcp, 'press', ['Enter'], { timeoutMs: 15000 });
    if (pressed.isError) throw new Error('Could not send the prompt');
  }
  await sleep(1000);
  const after = await pageSnapshot(mcp);
  if (composerHolds(after, prompt)) {
    const retry = sendRef(after);
    if (retry) await clickRef(mcp, retry);
    else await agentCall(mcp, 'press', ['Enter'], { timeoutMs: 15000 });
  }
}

async function approveUntilDone(mcp, scenario, directory, result) {
  const deadline = Date.now() + 480000;
  let snapshot = '';
  let mechanicFailures = 0;
  while (Date.now() < deadline) {
    snapshot = await pageSnapshot(mcp);
    for (const browser of await baoBrowserProcesses()) if (!result.existingBrowsers.has(browser.pid)) result.observedBrowsers.set(browser.pid, browser);
    const decision = approvalDecision(snapshot, { url: scenario.site.url, browser: scenario.browser });
    if (decision.action === 'refuse') return { snapshot, refused: decision.reason };
    if (decision.action === 'allow-once') {
      const always = snapshotElements(snapshot).find(element => element.role === 'button' && element.name === 'Always allow')?.ref;
      if (!decision.ref || decision.ref === always) throw new Error('Allow once target is missing');
      const file = `client-tool-${decision.command}.jpeg`;
      if (!result.toolPictures.some(picture => picture.command === decision.command)) {
        try {
          await saveShot(mcp, path.join(directory, file));
          result.toolPictures.push({ command: decision.command, at: new Date().toISOString(), file });
        } catch (error) { result.toolPictureError = error.message; }
      }
      try {
        await clickRef(mcp, decision.ref);
        mechanicFailures = 0;
      } catch (error) {
        mechanicFailures += 1;
        if (mechanicFailures >= 3) throw error;
      }
      await sleep(1000);
      continue;
    }
    const needs = needsInputRef(snapshot);
    if (needs) { await clickRef(mcp, needs).catch(() => undefined); await sleep(500); continue; }
    const checks = claudeReplyChecks(snapshot, scenario);
    if (checks.done && !stillGenerating(snapshot)) return { snapshot, refused: '' };
    await sleep(2000);
  }
  return { snapshot, refused: '' };
}

async function matchingClaudeRun(before, url) {
  const end = Date.now() + 45000;
  let found;
  while (Date.now() < end) {
    const runs = (await api('/api/state')).runs.filter(run => !before.has(run.id) && run.steps?.some(step => step.native?.command === 'open' && step.native?.args?.[0] === url));
    if (runs.length > 1) throw new Error(`Ambiguous scenario: ${runs.length} matching Bao runs`);
    if (runs[0]) {
      found = await api(`/api/runs/${encodeURIComponent(runs[0].id)}`);
      if (summarizeClaudeRun(found, url).closed) return found;
    }
    await sleep(1000);
  }
  return found;
}

async function runClaudeScenario(mcp, ui, scenario, output) {
  const directory = path.join(output, scenario.id);
  await mkdir(directory);
  const before = new Set((await api('/api/state')).runs.map(run => run.id));
  const result = { id: scenario.id, client: 'claude', site: scenario.site.host, browser: scenario.browser, startedAt: new Date().toISOString(), status: 'started', toolPictures: [], existingBrowsers: new Set((await baoBrowserProcesses()).map(browser => browser.pid)), observedBrowsers: new Map() };
  const prompt = claudeScenarioPrompt(scenario);
  await writeFile(path.join(directory, 'prompt.txt'), prompt);
  await jsonFile(path.join(directory, 'result.json'), { ...result, existingBrowsers: undefined, observedBrowsers: undefined });
  console.log(`${scenario.id}: sending read-only prompt`);
  await sendPrompt(mcp, prompt, path.join(directory, 'client-before.jpeg'));
  console.log(`${scenario.id}: waiting for tool rows and the reply`);
  const finished = await approveUntilDone(mcp, scenario, directory, result);
  const checks = claudeReplyChecks(finished.snapshot, scenario);
  result.completed = checks.done;
  result.reply = checks;
  result.clientReportedOutcome = checks.outcome;
  result.browserProcesses = [...result.observedBrowsers.values()];
  result.observedBrowser = result.browserProcesses.some(browser => browser.userDataDir.endsWith('/agent-browser-profile')) ? 'bao' : result.browserProcesses.length ? 'copy' : 'not_observed';
  await saveShot(mcp, path.join(directory, 'client-after.jpeg')).catch(error => { result.toolPictureError = result.toolPictureError || error.message; });
  const run = await matchingClaudeRun(before, scenario.site.url);
  Object.assign(result, summarizeClaudeRun(run, scenario.site.url));
  const remaining = new Set((await baoBrowserProcesses()).map(browser => browser.pid));
  result.browserProcessesClosed = result.browserProcesses.every(browser => !remaining.has(browser.pid));
  if (result.observedBrowser !== 'not_observed' && result.observedBrowser !== scenario.browser) result.status = 'wrong_browser';
  if (!result.browserProcessesClosed) result.status = 'browser_not_closed';
  if (result.toolPictureError && result.status === 'captured') result.status = 'evidence_error';
  if (!checks.title || !checks.copyDeleted) result.status = 'reply_incomplete';
  if (!checks.done) result.status = 'client_timeout';
  if (!result.browserProcessesClosed) result.status = 'browser_not_closed';
  if (finished.refused) result.status = 'refused_tool';
  result.refused = finished.refused || undefined;
  result.finishedAt = new Date().toISOString();
  const saved = { ...result, existingBrowsers: undefined, observedBrowsers: undefined };
  await jsonFile(path.join(directory, 'result.json'), saved);
  if (run) await receiptEvidence(ui, directory, run);
  console.log(`${scenario.id}: ${result.status}${result.runId ? ` (${result.runId})` : ''}`);
  if (finished.refused || result.status === 'unexpected_command' || !result.browserProcessesClosed) throw new Error(`Scenario ${scenario.id} stopped at ${result.status}`);
  return saved;
}

async function runToolProbe(mcp, output) {
  const directory = path.join(output, 'tool-probe');
  await mkdir(directory);
  const prompt = claudeToolPrompt();
  await writeFile(path.join(directory, 'prompt.txt'), prompt);
  const beforeNames = new Set(snapshotElements(await pageSnapshot(mcp)).filter(element => element.role === 'button').map(element => element.name));
  const tried = new Set();
  console.log('claude tool probe: sending read-only prompt');
  await sendPrompt(mcp, prompt, path.join(directory, 'before.jpeg'));
  const deadline = Date.now() + 180000;
  let snapshot = '';
  let chip = false;
  let answer = '';
  while (Date.now() < deadline) {
    snapshot = await pageSnapshot(mcp);
    if (allowOnceRef(snapshot) || needsInputRef(snapshot)) throw new Error('Tool-name prompt called a tool. Stopped without clicking Allow once.');
    if (!chip) chip = await confirmChatChip(mcp, beforeNames, tried);
    answer = toolProbeAnswer(snapshot);
    if (answer && !stillGenerating(snapshot)) break;
    await sleep(2000);
  }
  await saveShot(mcp, path.join(directory, 'reply.jpeg')).catch(() => undefined);
  if (!chip) chip = await confirmAnyChip(mcp, beforeNames, tried);
  if (!chip) throw new Error(CLAUDE_NOT_CONNECTED);
  answer = answer || toolProbeAnswer(await pageSnapshot(mcp));
  await writeFile(path.join(directory, 'tool-answer.txt'), answer || 'missing\n');
  if (answer !== 'yes') throw new Error(answer === 'no' ? 'claude.ai reported remote-devices bao is not available. Stopped without a site prompt.' : 'claude.ai did not answer BAO_TOOLS: yes. Stopped without a site prompt.');
  console.log('claude tool probe: remote-devices bao is listed');
}

async function disconnectOwned(mcp, tabId, lifecycle) {
  if (tabId) {
    try {
      await browserCall(mcp, 'tab', ['close', tabId], undefined, 20000);
      lifecycle.tabClosed = true;
    } catch { lifecycle.tabClosed = false; }
  }
  try {
    await browserCall(mcp, 'close', [], undefined, 20000);
    lifecycle.disconnected = true;
  } catch { lifecycle.disconnected = false; }
}

async function runClaude(options) {
  if (process.platform !== 'darwin') throw new Error('This runner needs the installed macOS apps');
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (options.output === checkout || options.output.startsWith(checkout + path.sep)) throw new Error('Evidence must stay outside the checkout');
  await access(installedMcp);
  await exec('/usr/bin/which', ['chrome-devtools-axi']);
  const initial = await api('/api/state');
  const installedLibrary = path.join(homedir(), 'Library/Application Support/bao');
  if (path.resolve(initial.home) !== path.resolve(installedLibrary)) throw new Error('Bao is not using the installed library. Stopped without opening claude.ai.');
  const chromeProfile = initial.settings.chromeProfile || 'Default';
  const hosts = await cookieHosts(chromeProfile);
  const selected = sites.filter(site => !options.site || site.host === options.site);
  for (const site of selected) if (!hosts.some(host => host.replace(/^\./, '') === site.host || host.endsWith('.' + site.host))) throw new Error(`No Chrome cookie host for ${site.host}; choose a signed-in site before running`);
  await mkdir(options.output, { recursive: true });
  if ((await readdir(options.output)).length) throw new Error('--output must be a new or empty local directory');
  await jsonFile(path.join(options.output, 'preflight.json'), { at: new Date().toISOString(), client: 'claude', baoHome: initial.home, chromeProfile, sites: selected.map(site => ({ host: site.host, cookieHosts: hosts.filter(host => host.replace(/^\./, '') === site.host || host.endsWith('.' + site.host)) })), existingRunIds: initial.runs.map(run => run.id) });
  const temporary = await mkdtemp(path.join(tmpdir(), 'bao-client-ui-'));
  const ui = session(`bao-receipt-${process.pid}`, { CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH: chrome, CHROME_DEVTOOLS_AXI_USER_DATA_DIR: temporary, CHROME_DEVTOOLS_AXI_CHROME_ARGS: '--use-mock-keychain --password-store=basic' });
  const results = [];
  const lifecycle = { taskTab: null, tabClosed: false, disconnected: false };
  let mcp;
  try {
    await ui('open', [baoURL]);
    await ui('resize', ['1440', '1000']);
    await capture(ui, options.output, 'bao-before');
    mcp = startInstalledMcp();
    await mcp.handshake();
    const opened = await browserCall(mcp, 'open', [claudeChat], 'current', 120000, true);
    const tabId = await taskTabId(mcp, opened.text);
    lifecycle.taskTab = tabId || null;
    if (!tabId) throw new Error('Could not identify the Bao task tab on claude.ai. Stopped without closing another tab.');
    await waitForChat(mcp);
    const device = await deviceMenuState(mcp, options.output);
    if (device === 'not-connected' || device === 'missing') throw new Error(CLAUDE_NOT_CONNECTED);
    await runToolProbe(mcp, options.output);
    await dismissMenus(mcp);
    for (const site of selected) for (const browser of ['copy', 'bao']) {
      const id = `claude-${site.host}-${browser}-${Date.now().toString(36)}`;
      const scenario = { id, site, browser };
      try {
        results.push(await runClaudeScenario(mcp, ui, scenario, options.output));
      } catch (error) {
        const file = path.join(options.output, id, 'result.json');
        const result = await readFile(file, 'utf8').then(JSON.parse).catch(() => ({ id, client: 'claude', site: site.host, browser, status: 'started' }));
        if (result.status === 'started') result.status = 'runner_error';
        Object.assign(result, { error: error.message, finishedAt: new Date().toISOString() });
        await mkdir(path.dirname(file), { recursive: true });
        await jsonFile(file, result);
        if (!results.some(item => item.id === id)) results.push(result);
        throw error;
      }
    }
  } finally {
    if (mcp) await disconnectOwned(mcp, lifecycle.taskTab, lifecycle).catch(error => { lifecycle.disconnectError = error.message; });
    if (mcp) await mcp.stop();
    try { await ui('stop'); }
    finally {
      await rm(temporary, { recursive: true, force: true });
      await jsonFile(path.join(options.output, 'claude-lifecycle.json'), lifecycle);
      await jsonFile(path.join(options.output, 'results.json'), results);
      await gallery(options.output, results, 'claude');
    }
  }
  if (lifecycle.taskTab && !lifecycle.tabClosed) throw new Error('Could not close the Bao task tab. Did not close any other tab.');
  if (!lifecycle.disconnected || lifecycle.disconnectError) throw new Error('Claude cleanup needs review; see claude-lifecycle.json');
  if (results.some(result => result.status !== 'captured' || result.clientReportedOutcome !== 'signed_in')) process.exitCode = 1;
}

export async function main(args) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('Usage: node scripts/test-desktop-clients.mjs --output /absolute/local/evidence [--site x.com|github.com|mail.google.com|linkedin.com] [--client chatgpt|claude]\nTests ChatGPT desktop in Codex mode with installed Bao. Creates real chats and Library runs. Keep evidence local. Claude Desktop rejects CDP launch flags, so --client claude drives claude.ai with the connected Mac instead of that window.');
    return;
  }
  if (options.client === 'claude') return runClaude(options);
  if (process.platform !== 'darwin') throw new Error('This runner needs the installed macOS apps');
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (options.output === checkout || options.output.startsWith(checkout + path.sep)) throw new Error('Evidence must stay outside the checkout');
  await checkRegistration();
  const initial = await api('/api/state');
  const chromeProfile = initial.settings.chromeProfile || 'Default';
  const hosts = await cookieHosts(chromeProfile);
  const selected = sites.filter(site => !options.site || site.host === options.site);
  for (const site of selected) if (!hosts.some(host => host.replace(/^\./, '') === site.host || host.endsWith('.' + site.host))) throw new Error(`No Chrome cookie host for ${site.host}; choose a signed-in site before running`);
  await mkdir(options.output, { recursive: true });
  if ((await readdir(options.output)).length) throw new Error('--output must be a new or empty local directory');
  await jsonFile(path.join(options.output, 'preflight.json'), { at: new Date().toISOString(), baoHome: initial.home, chromeProfile, sites: selected.map(site => ({ host: site.host, cookieHosts: hosts.filter(host => host.replace(/^\./, '') === site.host || host.endsWith('.' + site.host)) })), existingRunIds: initial.runs.map(run => run.id) });
  const temporary = await mkdtemp(path.join(tmpdir(), 'bao-client-ui-'));
  const ui = session(`bao-receipt-${process.pid}`, { CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH: chrome, CHROME_DEVTOOLS_AXI_USER_DATA_DIR: temporary, CHROME_DEVTOOLS_AXI_CHROME_ARGS: '--use-mock-keychain --password-store=basic' });
  const results = [];
  try {
    await ui('open', [baoURL]);
    await ui('resize', ['1440', '1000']);
    await capture(ui, options.output, 'bao-before');
    const port = await freePort();
    const axi = session(`bao-client-chatgpt-${process.pid}`, { CHROME_DEVTOOLS_AXI_BROWSER_URL: `http://127.0.0.1:${port}` });
    const lifecycle = { originalPid: await mainPid(client), debugPort: port };
    let startedPid;
    let draft = '';
    try {
      await terminate(lifecycle.originalPid);
      await exec('/usr/bin/open', ['-a', client.app, '--args', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`]);
      await waitUntil(async () => { startedPid = await mainPid(client); try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 20000, 'ChatGPT has no CDP endpoint after launch');
      lifecycle.startedPid = startedPid;
      await waitUntil(async () => {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
        return targets.some(target => target.type === 'page' && target.url.split('?')[0] === client.target && !target.url.includes('initialRoute='));
      }, 30000, 'ChatGPT main conversation target is missing');
      const pages = await axi('pages');
      const row = pages.split('\n').find(line => line.trim().split(',')[1]?.split('?')[0] === client.target && !line.includes('initialRoute='));
      if (!row) throw new Error('ChatGPT main conversation page is missing');
      await axi('selectpage', [row.trim().split(',')[0]]);
      await waitUntil(async () => evaluate(axi, `() => [...document.querySelectorAll('button')].some(button => button.getClientRects().length && button.getAttribute('aria-label') === 'Switch mode, current mode: Codex')`), 15000, 'Choose Codex mode in ChatGPT before running this command');
      await waitUntil(async () => (await readComposer(axi, client.composer)) !== null, 15000, 'Initial client composer did not appear');
      draft = await readComposer(axi, client.composer);
      for (const site of selected) for (const browser of ['copy', 'bao']) {
        const id = `chatgpt-${site.host}-${browser}-${Date.now().toString(36)}`;
        try {
          results.push(await runScenario(axi, ui, client, { id, client: 'chatgpt', site, browser }, options.output));
        } catch (error) {
          const file = path.join(options.output, id, 'result.json');
          const result = JSON.parse(await readFile(file, 'utf8'));
          if (result.status === 'started') result.status = 'runner_error';
          Object.assign(result, { error: error.message, finishedAt: new Date().toISOString() });
          await jsonFile(file, result);
          results.push(result);
          throw error;
        }
      }
    } finally {
      if (draft) {
        try {
          await newChat(axi, client);
          await typeInClient(axi, client.composer, draft);
          lifecycle.draftRestored = true;
        } catch (error) { lifecycle.draftRestoreError = error.message; }
      }
      await axi('stop').catch(error => { lifecycle.bridgeStopError = error.message; });
      if (startedPid) await terminate(startedPid);
      await exec('/usr/bin/open', ['-a', client.app]);
      await waitUntil(async () => Boolean(await mainPid(client)), 15000, 'ChatGPT did not reopen normally');
      lifecycle.normalPid = await mainPid(client);
      lifecycle.debugPortClosed = !await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false);
      await jsonFile(path.join(options.output, 'client-lifecycle.json'), lifecycle);
      if (!lifecycle.debugPortClosed || lifecycle.bridgeStopError || lifecycle.draftRestoreError) throw new Error('Client cleanup needs review; see client-lifecycle.json');
    }
  } finally {
    try { await ui('stop'); }
    finally {
      await rm(temporary, { recursive: true, force: true });
      await jsonFile(path.join(options.output, 'results.json'), results);
      await gallery(options.output, results);
    }
  }
  if (results.some(result => result.status !== 'captured' || result.clientReportedOutcome !== 'signed_in')) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
