#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(repo, 'package.json'));
const execute = promisify(execFile);
const built = (file) => require(path.join(repo, 'desktop/dist/desktop', file));
const { laneChildEnv } = built('test/runtime.js');
const { startLane } = built('test/instacart/lane.js');
const { TARGET } = built('test/instacart/fixture.js');
const { McpClient } = built('src/eval/mcp-client.js');
const { Library } = built('src/v1/store.js');
const { launchOwnedChrome, pidsForDataDir } = built('src/launch.js');

async function doctor(instance) {
  process.kill(instance.serverPid, 0);
  const command = execFileSync('ps', ['-p', String(instance.serverPid), '-o', 'command='], { encoding: 'utf8' });
  assert.ok(command.includes(path.join(repo, 'desktop/dist/desktop/src/app/cli.js')) && command.includes(instance.home), 'server PID is not this Bao instance');
  const listener = execFileSync('lsof', ['-t', `-iTCP:${new URL(instance.url).port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
  assert.equal(listener, String(instance.serverPid), 'app port belongs to another process');
  assert.ok(pidsForDataDir(instance.fixtureProfile).length, 'fixture browser is gone');
  const server = JSON.parse(readFileSync(path.join(instance.home, 'server.json'), 'utf8'));
  assert.equal(server.port, new URL(instance.url).port * 1);
  const response = await fetch(`${instance.url}/api/state`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.ok(Array.isArray(state.workflows) && Array.isArray(state.runs));
  assert.equal(instance.revision, execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  return { url: instance.url, home: instance.home, revision: instance.revision, workflows: state.workflows.length, runs: state.runs.length };
}

const [command, destination] = process.argv.slice(2);
assert.ok(destination && path.isAbsolute(destination), 'usage: verify.mjs run <new absolute evidence dir> | doctor <instance.json>');
if (command === 'doctor') {
  console.log(JSON.stringify(await doctor(JSON.parse(readFileSync(destination, 'utf8'))), null, 2));
} else {
  assert.equal(command, 'run');
  assert.ok(!existsSync(destination), 'choose a new evidence directory; never overwrite proof');
  assert.ok(!destination.startsWith(`${repo}/`), 'keep proof outside the checkout');
  mkdirSync(destination, { recursive: true });
  const save = (name, value) => writeFileSync(path.join(destination, name), JSON.stringify(value, null, 2) + '\n');
  const env = laneChildEnv('hermetic', process.env);
  Object.assign(process.env, env);
  // Delete inherited BAO names and model keys too, not only those in the child env.
  for (const key of Object.keys(process.env)) {
    if ((/^bao/i.test(key) || /^(OPENAI|ANTHROPIC|GROQ|XAI|CURSOR)_API_KEY$/.test(key)) && !(key in env)) delete process.env[key];
  }
  let lane;
  let mcp;
  let ui;
  let axiEnv;
  let instance;
  let failure;
  const transcript = [];
  const axi = async (...args) => {
    try {
      const child = execute('chrome-devtools-axi', args[0] === 'run' ? ['run'] : args, { env: axiEnv, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
      if (args[0] === 'run') child.child.stdin.end(args[1]);
      const { stdout: output } = await child;
      transcript.push({ browser: args, output });
      return output;
    } catch (error) {
      transcript.push({ browser: args, error: error.message, stdout: error.stdout, stderr: error.stderr });
      throw error;
    } finally {
      save('actions.json', transcript);
    }
  };
  const screen = async (name) => {
    const snapshot = await axi('snapshot');
    assert.ok(snapshot.includes(`button "${name}"`), `missing sidebar button ${name}`);
    assert.ok(['Library', 'Runs'].includes(name));
    await axi('run', `await page.click('button[data-screen="${name.toLowerCase()}"]');`);
  };
  const tool = async (name, args = {}) => {
    const reply = await mcp.call(name, args);
    transcript.push({ tool: name, arguments: args, reply });
    save('actions.json', transcript);
    assert.equal(reply.isError, false, reply.text);
    return JSON.parse(reply.text);
  };
  const ref = (body, label) => {
    const control = body.view?.controls.find((item) => item.label === label);
    assert.ok(control?.ref, `missing control ${label}: ${JSON.stringify(body)}`);
    return control.ref;
  };
  try {
    lane = await startLane('verify-bao', env);
    const server = JSON.parse(readFileSync(path.join(lane.home, 'server.json'), 'utf8'));
    const url = `http://127.0.0.1:${server.port}`;
    const serverPid = Number(execFileSync('lsof', ['-t', `-iTCP:${server.port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim());
    instance = { url, home: lane.home, root: lane.root, serverPid, fixtureProfile: lane.browser.userDataDir, uiProfile: path.join(lane.root, 'ui-chrome'), revision: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), executable: lane.browser.executable, fixture: 'LOCAL HTTPS fixture, not Instacart production' };
    save('instance.json', instance);
    save('doctor-before.json', await doctor(instance));
    console.log(`bao verification ${url}; instance ${path.join(destination, 'instance.json')}`);
    ui = await launchOwnedChrome({ userDataDir: instance.uiProfile, childHome: lane.env.HOME, headless: true, loadExtensions: false });
    const cdpPort = readFileSync(path.join(instance.uiProfile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    axiEnv = { ...lane.env };
    for (const key of Object.keys(axiEnv)) if (key.startsWith('CHROME_DEVTOOLS_AXI_')) delete axiEnv[key];
    Object.assign(axiEnv, { CHROME_DEVTOOLS_AXI_SESSION: `bao-verify-${process.pid}`, CHROME_DEVTOOLS_AXI_BROWSER_URL: `http://127.0.0.1:${cdpPort}` });
    await axi('open', url);
    await axi('resize', '1440', '1000');
    writeFileSync(path.join(destination, 'library-before.txt'), await axi('snapshot'));
    await axi('screenshot', path.join(destination, 'library-before.png'));
    await screen('Runs');
    await axi('wait', 'No runs yet');
    writeFileSync(path.join(destination, 'runs-before.txt'), await axi('snapshot'));
    await axi('screenshot', path.join(destination, 'runs-before.png'));
    await screen('Library');

    mcp = McpClient.start(lane.env);
    const tools = await mcp.handshake();
    for (const name of ['live_session_start', 'live_snapshot', 'live_stop', 'run_workflow']) assert.ok(tools.includes(name), name);
    save('tools.json', tools);
    lane.fixture.reset();
    const started = await tool('live_session_start', { careful: true, intent: 'put costco blueberries into the cart at instacart', url: lane.fixture.url('/store/costco/storefront') });
    assert.equal(started.outcome.kind, 'applied');
    const snapshot = await tool('live_snapshot');
    const typed = await tool('live_type', { ref: ref(snapshot, 'Search Costco'), text: 'blueberries' });
    const results = await tool('live_key', { ref: ref(typed, 'Search Costco'), key: 'Enter' });
    const added = await tool('live_click', { ref: ref(results, `Add 1 ct ${TARGET.name}`) });
    assert.equal(added.outcome.kind, 'applied');
    assert.equal((await tool('live_stop')).outcome.kind, 'stopped');
    const library = new Library(lane.home);
    const workflow = library.read(started.session);
    assert.deepEqual(workflow.steps.map((step) => step.action), ['type', 'key', 'click']);
    save('workflow.json', workflow);
    save('fixture-recorded.json', lane.fixture.state());
    assert.deepEqual(lane.fixture.state().writes.map((write) => [write.op, write.productId, write.after]), [['add', TARGET.id, 1]]);

    save('doctor-replay.json', await doctor(instance));
    lane.fixture.reset();
    const replay = await tool('run_workflow', { id: workflow.id });
    assert.equal(replay.outcome, 'ok', JSON.stringify(replay));
    const run = library.readRun(replay.runId);
    assert.equal(run.status, 'passed');
    assert.equal(run.modelCalls, 0);
    assert.deepEqual(run.heals, []);
    assert.deepEqual(lane.fixture.state().writes.map((write) => [write.op, write.productId, write.after]), [['add', TARGET.id, 1]]);
    assert.deepEqual(lane.fixture.state().traps, []);
    save('run.json', run);
    cpSync(path.join(lane.home, 'shots', 'runs', run.id), path.join(destination, 'run-shots'), { recursive: true });
    save('fixture-replayed.json', lane.fixture.state());
    assert.equal(existsSync(lane.lockFile), false);

    save('doctor-ui.json', await doctor(instance));
    await axi('reload');
    await axi('wait', workflow.name);
    writeFileSync(path.join(destination, 'library-after.txt'), await axi('snapshot'));
    await axi('screenshot', path.join(destination, 'library-after.png'));
    await screen('Runs');
    await axi('wait', 'passed');
    const runs = await axi('snapshot');
    assert.match(runs, /passed/i);
    const visibleRuns = await axi('eval', 'document.querySelector("#runs").innerText');
    assert.ok(visibleRuns.includes(workflow.name));
    writeFileSync(path.join(destination, 'runs-visible.txt'), visibleRuns);
    assert.ok(runs.includes(run.id));
    assert.match(runs, /0 model calls/);
    writeFileSync(path.join(destination, 'runs-after.txt'), runs);
    await axi('screenshot', path.join(destination, 'runs-after.png'));
    save('result.json', { status: 'passed', workflowId: workflow.id, runId: run.id, modelCalls: run.modelCalls, realSite: false });
  } catch (error) {
    failure = error;
    save('failure.json', { message: error.message, stack: error.stack });
  } finally {
    const cleanupErrors = [];
    if (mcp) writeFileSync(path.join(destination, 'mcp-stderr.txt'), mcp.stderr.join(''));
    for (const close of [() => mcp?.close(), () => axiEnv && axi('stop'), () => ui?.close(), () => lane?.close()]) {
      try { await close(); } catch (error) { cleanupErrors.push(error.message); }
    }
    if (instance) {
      for (const profile of [instance.fixtureProfile, instance.uiProfile]) {
        if (pidsForDataDir(profile).length) cleanupErrors.push(`browser still owns ${profile}`);
      }
      try { process.kill(instance.serverPid, 0); cleanupErrors.push(`server PID still alive: ${instance.serverPid}`); } catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(error.message); }
      if (existsSync(instance.root)) cleanupErrors.push(`temp copy remains: ${instance.root}`);
      if (existsSync(instance.fixtureProfile)) cleanupErrors.push(`fixture profile remains: ${instance.fixtureProfile}`);
      try { await fetch(`${instance.url}/api/state`, { signal: AbortSignal.timeout(2000) }); cleanupErrors.push('server still answers'); } catch {}
    }
    save('cleanup.json', { status: cleanupErrors.length ? 'failed' : 'passed', errors: cleanupErrors });
    if (cleanupErrors.length && !failure) failure = new Error(cleanupErrors.join('; '));
  }
  if (failure) throw failure;
  for (const name of ['library-before.png', 'library-after.png', 'runs-before.png', 'runs-after.png', 'actions.json', 'workflow.json', 'run.json', 'cleanup.json']) assert.ok(existsSync(path.join(destination, name)), `lost evidence ${name}`);
  console.log(`PASS (local fixture only); evidence survives cleanup: ${destination}`);
}
