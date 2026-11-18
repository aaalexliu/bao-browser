// The receipt's step player: it shows one step's picture at a time, moves to the next by itself,
// and keeps the step list on the step it shows. The markup comes from receiptPlayerHtml in views.ts.

/** How long the player shows each step at 1×. */
const STEP_MS = 1200;
const SPEEDS = [1, 2, 4];

interface Playback {
  run: string;
  step: number;
  playing: boolean;
  speed: number;
  /** Set once the player has started by itself or the owner has used it, so a redraw does not start it again. */
  started: boolean;
  /** Whether the step list scrolls with the player. The reader's own scrolling turns it off until they use the player again. */
  following: boolean;
}

// One receipt is open at a time. This outlives a redraw of that receipt, so the player goes on where it was.
// Opening another run starts that run's player from its first step.
let playback: Playback | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let watcher: IntersectionObserver | undefined;

/** Binds the player in a freshly drawn receipt. A receipt with no player only clears the last one's timer. */
export function bindReceiptPlayer(host: HTMLElement, runId: string): void {
  clearTimeout(timer);
  watcher?.disconnect();
  const player = host.querySelector<HTMLElement>("#receipt-player");
  if (!player) return;
  const total = Number(player.dataset.steps);
  if (playback?.run !== runId) playback = { run: runId, step: 1, playing: false, speed: 1, started: false, following: true };
  const state = playback;
  state.step = Math.min(Math.max(1, state.step), total);

  const stage = player.querySelector<HTMLElement>(".player-stage")!;
  const picture = player.querySelector<HTMLImageElement>("#player-picture")!;
  const empty = player.querySelector<HTMLElement>("#player-empty")!;
  const chapter = player.querySelector<HTMLElement>("#player-chapter")!;
  const caption = player.querySelector<HTMLElement>("#player-line")!;
  const count = player.querySelector<HTMLElement>("#player-count")!;
  const seek = player.querySelector<HTMLInputElement>("#player-seek")!;
  const toggle = player.querySelector<HTMLButtonElement>("#player-toggle")!;
  const speed = player.querySelector<HTMLButtonElement>("#player-speed")!;
  const list = host.querySelector<HTMLElement>(".receipt-list")!;
  const marks = [...player.querySelectorAll<HTMLElement>(".player-mark")];
  const rows = new Map([...list.querySelectorAll<HTMLElement>("li[data-step]")].map((row) => [Number(row.dataset.step), row]));
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const follow = (row: HTMLElement, smooth: boolean) => {
    // Scroll the pane, never the page: scrollIntoView would move the receipt under the reader.
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTo({ top: top - (list.clientHeight - row.offsetHeight) / 2, behavior: smooth && !calm ? "smooth" : "instant" });
  };

  const show = (step: number, scroll: "smooth" | "instant" | "none") => {
    state.step = Math.min(Math.max(1, step), total);
    const row = rows.get(state.step);
    const src = row?.dataset.picture || "";
    if (src && picture.getAttribute("src") !== src) picture.src = src;
    picture.hidden = !src;
    empty.hidden = Boolean(src);
    const line = row?.querySelector(".receipt-step-line")?.textContent || "";
    const note = row?.dataset.pictureNote || "";
    picture.alt = note || line;
    caption.textContent = note ? `${line}. ${note}` : line;
    const section = row?.closest(".receipt-chapter");
    chapter.textContent = section?.querySelector(".receipt-chapter-title")?.textContent || "";
    const start = section?.querySelector<HTMLElement>("li[data-step]")?.dataset.step;
    for (const mark of marks) mark.classList.toggle("on", mark.dataset.receiptStep === start);
    count.textContent = `${state.step} / ${total}`;
    seek.value = String(state.step);
    seek.style.setProperty("--played", `${total > 1 ? ((state.step - 1) / (total - 1)) * 100 : 0}%`);
    seek.setAttribute("aria-valuetext", `Step ${state.step} of ${total}: ${line}`);
    for (const [n, item] of rows) {
      item.classList.toggle("current", n === state.step);
      if (n === state.step) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    }
    if (row && scroll !== "none" && state.following) follow(row, scroll === "smooth");
    const next = rows.get(state.step + 1)?.dataset.picture;
    if (next) new Image().src = next;
  };

  const schedule = () => {
    clearTimeout(timer);
    if (!state.playing) return;
    timer = setTimeout(() => {
      if (!player.isConnected) {
        state.playing = false;
        return;
      }
      if (state.step >= total) {
        play(false);
        return;
      }
      show(state.step + 1, "smooth");
      schedule();
    }, STEP_MS / state.speed);
  };

  const paint = () => {
    toggle.dataset.playing = String(state.playing);
    toggle.setAttribute("aria-label", state.playing ? "Pause" : "Play");
    speed.textContent = `${state.speed}×`;
    speed.setAttribute("aria-label", `Speed ${state.speed}×`);
  };

  const play = (on: boolean) => {
    state.playing = on;
    state.started = true;
    state.following = true;
    paint();
    schedule();
  };

  /** A step the owner picked: show it, and give it a full turn before the player moves on. */
  const pick = (step: number) => {
    state.started = true;
    state.following = true;
    show(step, "smooth");
    schedule();
  };

  toggle.onclick = () => {
    if (!state.playing && state.step >= total) show(1, "smooth");
    play(!state.playing);
  };
  stage.onclick = toggle.onclick;
  speed.onclick = () => {
    state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length]!;
    paint();
    schedule();
  };
  seek.oninput = () => pick(Number(seek.value));
  // A wheel, a touch or a press in the pane is the reader looking for a step. A press on a row then picks it, which follows again.
  list.onwheel = list.ontouchmove = list.onpointerdown = () => { state.following = false; };
  host.querySelectorAll<HTMLElement>("[data-receipt-step]").forEach((button) => {
    button.onclick = () => pick(Number(button.dataset.receiptStep));
  });

  show(state.step, state.started ? "instant" : "none");
  paint();
  schedule();
  if (state.started || calm) return;
  // Start once the reader can see most of the stage. The proof shot above pushes the player down when it loads, so wait for it.
  const watch = () => {
    if (!stage.isConnected) return;
    watcher = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.intersectionRatio >= 0.6)) return;
      watcher?.disconnect();
      if (!state.started) play(true);
    }, { threshold: 0.6 });
    watcher.observe(stage);
  };
  const proof = host.querySelector<HTMLImageElement>(".receipt-proof img");
  if (!proof || proof.complete) return watch();
  proof.addEventListener("load", watch, { once: true });
  proof.addEventListener("error", watch, { once: true });
}
