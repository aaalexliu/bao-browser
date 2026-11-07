#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
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
  const options = { output: '', site: '' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') return { help: true };
    if (!['--output', '--site'].includes(key) || !args[i + 1]) throw new Error(`Unknown or incomplete argument: ${key}`);
    options[key.slice(2)] = args[++i];
  }
  if (!path.isAbsolute(options.output)) throw new Error('--output must be an absolute local directory outside the checkout');
  if (options.site && !sites.some(site => site.host === options.site)) throw new Error('--site must name one of the four documented sites');
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
async function gallery(output, results) {
  const sections = [];
  for (const result of results) {
    const files = await readdir(path.join(output, result.id));
    const pictures = ['client-before.jpeg', ...files.filter(file => /^client-tool-(open|snapshot|screenshot)\.jpeg$/.test(file)), 'client-after.jpeg', 'bao-receipt.jpeg', ...files.filter(file => /^site-picture\.(png|jpg|jpeg)$/.test(file))].filter(file => files.includes(file));
    sections.push(`<section><h2>${result.site} / ${result.browser}: ${result.status}</h2><p><a href="${result.id}/result.json">JSON result</a></p>${pictures.map(file => `<h3>${file}</h3><img src="${result.id}/${file}" alt="${result.site} ${result.browser} ${file}" loading="lazy">`).join('')}</section>`);
  }
  await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Bao in ChatGPT desktop</title><style>html{background:#fff;color:#161616;font:16px/1.5 system-ui}body{max-width:1440px;margin:32px auto;padding:0 24px}img{display:block;width:100%;height:auto}section{margin:48px 0}h3{font-size:16px}</style><h1>Bao in ChatGPT desktop</h1><p>Local evidence. Captured commands do not by themselves prove a working sign-in. Read each result and inspect each picture. Claude Desktop is not covered.</p>${sections.join('')}</html>\n`);
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

export async function main(args) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('Usage: node scripts/test-desktop-clients.mjs --output /absolute/local/evidence [--site x.com|github.com|mail.google.com|linkedin.com]\nTests ChatGPT desktop in Codex mode with installed Bao. Creates real chats and Library runs. Keep evidence local. Claude Desktop currently rejects CDP startup.');
    return;
  }
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
