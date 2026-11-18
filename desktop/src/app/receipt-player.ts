// The receipt's step player. It plays the run's video when the run has one, and otherwise shows one step's
// picture at a time and moves to the next by itself. Either way it keeps the step list on the step it shows.
// The markup comes from receiptPlayerHtml in views.ts.

/** How long the player shows each step at 1×. */
const STEP_MS = 1200;
const SPEEDS = [1, 2, 4];

interface Playback {
  run: string;
  step: number;
  /** Seconds into the video, for a run that has one. */
  time: number;
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
  if (playback?.run !== runId) playback = { run: runId, step: 1, time: 0, playing: false, speed: 1, started: false, following: true };
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
  const video = player.querySelector<HTMLVideoElement>("#player-video");
  const starts = [...rows].flatMap(([step, row]) => row.dataset.at === undefined ? [] : [{ step, at: Number(row.dataset.at) }]);
  const skips = JSON.parse(video?.dataset.skips || "[]") as { from: number; to: number }[];
  // A video that cannot load leaves the pictures to play.
  let film = Boolean(video) && !video!.error && starts.length > 0;

  /** The step whose start is the latest at or before `time`. Before the first start, the first timed step. */
  const stepAt = (time: number) => starts.reduce((best, item) => item.at <= time + 0.04 && item.at >= best.at ? item : best, { step: starts[0]!.step, at: -Infinity }).step;
  const seekVideo = (time: number) => {
    const go = () => { video!.currentTime = Number.isFinite(video!.duration) ? Math.min(time, Math.max(0, video!.duration - 0.05)) : time; };
    if (video!.readyState >= 1) go();
    else video!.addEventListener("loadedmetadata", go, { once: true });
  };

  const follow = (row: HTMLElement, smooth: boolean) => {
    // Scroll the pane, never the page: scrollIntoView would move the receipt under the reader.
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTo({ top: top - (list.clientHeight - row.offsetHeight) / 2, behavior: smooth && !calm ? "smooth" : "instant" });
  };

  const show = (step: number, scroll: "smooth" | "instant" | "none") => {
    state.step = Math.min(Math.max(1, step), total);
    const row = rows.get(state.step);
    const src = row?.dataset.picture || "";
    if (!film && src && picture.getAttribute("src") !== src) picture.src = src;
    if (video) video.hidden = !film;
    picture.hidden = film || !src;
    empty.hidden = film || Boolean(src);
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
    if (!film && next) new Image().src = next;
  };

  const schedule = () => {
    clearTimeout(timer);
    if (film || !state.playing) return;
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
    if (!film) return;
    video!.playbackRate = state.speed;
    if (on) void video!.play().catch(() => { state.playing = false; paint(); });
    else video!.pause();
  };

  /** A step the owner picked: show it, and give it a full turn before the player moves on. */
  const pick = (step: number) => {
    state.started = true;
    state.following = true;
    const at = film ? starts.find((item) => item.step === step)?.at : undefined;
    if (at !== undefined) seekVideo(at);
    show(step, "smooth");
    schedule();
  };

  toggle.onclick = () => {
    if (!state.playing && (film ? video!.ended : state.step >= total)) pick(film ? stepAt(0) : 1);
    play(!state.playing);
  };
  stage.onclick = toggle.onclick;
  speed.onclick = () => {
    state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length]!;
    paint();
    schedule();
    if (film) video!.playbackRate = state.speed;
  };
  if (video) {
    const tick = () => {
      if (!film || video.seeking) return;
      const time = video.currentTime;
      // Idle between steps is not worth watching: playing jumps a gap that idleSkips names.
      const skip = state.playing ? skips.find((gap) => time >= gap.from && time < gap.to - 0.05) : undefined;
      if (skip) {
        video.currentTime = skip.to;
        return;
      }
      state.time = time;
      const step = stepAt(time);
      if (step !== state.step) show(step, "smooth");
    };
    video.ontimeupdate = tick;
    video.onseeked = tick;
    video.onended = () => { state.playing = false; paint(); };
    video.onpause = () => { if (!player.isConnected) state.playing = false; };
    video.onerror = () => {
      film = false;
      show(state.step, "none");
      schedule();
    };
  }
  seek.oninput = () => pick(Number(seek.value));
  // A wheel, a touch or a press in the pane is the reader looking for a step. A press on a row then picks it, which follows again.
  list.onwheel = list.ontouchmove = list.onpointerdown = () => { state.following = false; };
  host.querySelectorAll<HTMLElement>("[data-receipt-step]").forEach((button) => {
    button.onclick = () => pick(Number(button.dataset.receiptStep));
  });

  show(state.step, state.started ? "instant" : "none");
  paint();
  schedule();
  if (film && state.started) {
    seekVideo(state.time);
    if (state.playing) play(true);
  }
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
