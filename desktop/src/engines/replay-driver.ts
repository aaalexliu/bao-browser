import type { Page } from "playwright";
import { CdpLiveDriver, TRUST_CLEANUP } from "../cdp-live/driver";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../cdp-live/socket";
import type { PersonPrompts, FileProof } from "../v1/browser-driver";
import type { FailureSnapshot } from "../v1/heal";
import type { HumanAsk } from "../v1/human-ask";
import type { HealNotice } from "../v1/replay";
import type { Identity } from "../v1/schema";
import { AgentBrowserPage } from "./agent-browser";

/** Trial replay uses the same Bao DOM identities and CDP host/target guards as live runs. */
export class AgentBrowserReplayDriver extends CdpLiveDriver {
  readonly proofs: FileProof[] = [];
  private constructor(
    private readonly connection: CdpSocket,
    sessionId: string,
    targetId: string,
    hosts: readonly string[],
    private readonly engine: AgentBrowserPage,
    private readonly prompts?: PersonPrompts,
    private readonly onNotify?: (notice: HealNotice) => void,
  ) {
    super(connection, sessionId, targetId, hosts);
    this.usePageEngine(engine);
  }

  static async open(options: {
    page: Page; portFile: string; hosts: string[]; artifactDir: string;
    prompts?: PersonPrompts; onNotify?: (notice: HealNotice) => void;
  }): Promise<AgentBrowserReplayDriver> {
    const endpoint = await readDevToolsActivePort(options.portFile);
    // Read the target from the page Bao launched, never from the browser's active tab.
    const probe = await options.page.context().newCDPSession(options.page);
    const { targetInfo } = await probe.send("Target.getTargetInfo");
    await probe.detach();
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    let engine: AgentBrowserPage | undefined;
    try {
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: targetInfo.targetId, flatten: true });
      engine = await AgentBrowserPage.open({
        endpoint: `ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`,
        targetId: targetInfo.targetId, ownership: "bao-launched", artifactDir: options.artifactDir,
      });
      const driver = new AgentBrowserReplayDriver(cdp, attached.sessionId, targetInfo.targetId, options.hosts, engine, options.prompts, options.onNotify);
      await driver.start();
      return driver;
    } catch (error) {
      await engine?.close();
      cdp.close();
      throw error;
    }
  }

  markStep(_id: string): void {}
  override async notify(notice?: HealNotice): Promise<void> { if (notice) this.onNotify?.(notice); }
  showConfirm(label: string): void { this.prompts?.showConfirm?.(label); }
  clearConfirm(): void { this.prompts?.clearConfirm?.(); }
  showLoginWait(label: string): void { this.prompts?.showLoginWait?.(label); }
  clearLoginWait(): void { this.prompts?.clearLoginWait?.(); }
  override showAsk(ask: HumanAsk): void { super.showAsk(ask); this.prompts?.showAsk?.(ask); }
  shouldStop(): boolean { return this.prompts?.shouldStop?.() ?? false; }
  loginContinued(): boolean { return this.prompts?.loginContinued?.() ?? false; }
  override pauseCapture(): void { super.pauseCapture(); this.prompts?.pauseCapture?.(); }
  override resumeCapture(): void { super.resumeCapture(); this.prompts?.resumeCapture?.(); }

  async focus(node: Identity): Promise<void> {
    const handle = this.handleOf(node);
    if (!handle) throw new Error("element handle expired");
    await this.engine.focus(`[data-bao-i="${handle}"]`);
  }

  override async snapshot(): Promise<FailureSnapshot> {
    const dom = await super.snapshot();
    const png = await this.pageShot();
    return { ...dom, screenshot: png.toString("base64"), screenshotRef: `png:${png.length}` };
  }
  async captureStep(): Promise<{ ax?: string }> {
    const snapshot = await super.snapshot();
    return { ax: typeof snapshot.ax === "string" ? snapshot.ax : undefined };
  }
  async readList(): Promise<never> { throw new Error("agent-browser trial does not extract lists"); }
  trace() { return { console: [], network: [], unavailable: "agent-browser trial does not collect console or network traces" }; }
  async download(): Promise<never> { throw new Error("agent-browser trial does not capture downloads"); }
  async pickDate(): Promise<never> { throw new Error("agent-browser trial does not pick dates or drag"); }
  answerDialog(): never { throw new Error("agent-browser trial does not answer dialogs"); }

  /** The replay owns the browser elsewhere; leave its page available for person handoff. */
  async dispose(): Promise<void> {
    await this.engine.evaluate(TRUST_CLEANUP).catch(() => undefined);
    await this.engine.close();
    this.connection.close();
  }
}
