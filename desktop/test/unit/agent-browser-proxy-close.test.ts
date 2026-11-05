import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as launch from "../../src/launch";

launch.pinTestBrowser();

test("window close and proxy cleanup await the owned shutdown before reopening", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-proxy-close-"));
  const sourceRoot = path.join(root, "source");
  const home = path.join(root, "home");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
const command = args[args.indexOf('--idle-timeout') + 2];
if (command === 'tab' && args.includes('--json')) {
  const endpoint = new URL(args[args.indexOf('--cdp') + 1]);
  fetch('http://' + endpoint.host + '/json/list').then(r => r.json()).then(targets => {
    console.log(JSON.stringify({ data: { tabs: targets.filter(t => t.type === 'page').map((t, index) => ({ targetId: t.id, active: index === 0 })) } }));
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else { process.stdout.write('native success\\n'); }
`, { mode: 0o700 });
  const ownedLaunch = launch.launchOwnedChromeEndpoint;
  const chromes: Awaited<ReturnType<typeof ownedLaunch>>[] = [];
  const copies: string[] = [];
  t.mock.method(launch, "launchOwnedChromeEndpoint", async (options: Parameters<typeof ownedLaunch>[0]) => {
    const chrome = await ownedLaunch({ ...options, headless: true });
    chromes.push(chrome);
    copies.push(options.userDataDir);
    return chrome;
  });
  const proxy = new AgentBrowserProxy({ home, sourceRoot, executable });
  try {
    await proxy.execute("open");
    const chrome = chromes[0]!;
    const endpoint = await readDevToolsActivePort(chrome.portFile);
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
      const pages = targetInfos.filter(target => target.type === "page");
      assert.equal(pages.length, 1);
      await cdp.send("Target.closeTarget", { targetId: pages[0]!.targetId });
      await chrome.closed;
    } finally { cdp.close(); }
    const reopened = await proxy.execute("open");
    assert.equal(reopened[0]!.stdout, "native success\n");
    assert.equal(chromes.length, 2);
    assert.notEqual(copies[0], copies[1]);
    await assert.rejects(access(copies[0]!), /ENOENT/);
    assert.equal(launch.pidsForDataDir(copies[0]!).length, 0);
    const endpoint2 = await readDevToolsActivePort(chromes[1]!.portFile);
    const cdp2 = await connectCdp(endpoint2.port, endpoint2.browserPath);
    try {
      const { targetInfos } = await cdp2.send<{ targetInfos: { type: string }[] }>("Target.getTargets");
      assert.equal(targetInfos.filter(target => target.type === "page").length, 1);
    } finally { cdp2.close(); }
  } finally {
    await proxy.close().catch(() => undefined);
    for (const chrome of chromes) await chrome.close().catch(() => undefined);
    for (const copy of copies) {
      assert.equal(launch.pidsForDataDir(copy).length, 0);
      await rm(path.dirname(copy), { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});
