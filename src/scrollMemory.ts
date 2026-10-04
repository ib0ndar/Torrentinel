// Scroll positions per history entry, for Back/Forward and reloads. Browsers restore the position
// before an asynchronously loaded list is tall enough, so restoration is manual: each entry carries
// a key in history.state and its last scroll position is kept in memory and sessionStorage.
const STORAGE_KEY = "torrentinel-scroll-positions";
const MAX_ENTRIES = 50;

const positions = new Map<string, number>(readStored());
let saveTimer: number | undefined;

function readStored(): Array<[string, number]> {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((entry): entry is [string, number] => typeof entry?.[0] === "string" && typeof entry?.[1] === "number") : [];
  } catch { return []; }
}
function persist(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...positions].slice(-MAX_ENTRIES))); } catch { /* storage unavailable */ }
  }, 250);
}
function newKey(): string { return Math.random().toString(36).slice(2, 10); }
type EntryState = { key?: string } & Record<string, unknown>;
function currentState(): EntryState { const state = window.history.state; return state && typeof state === "object" ? state as EntryState : {}; }

/** The key of the current history entry, assigning one if the entry has none yet. */
export function entryKey(): string {
  const state = currentState();
  if (typeof state.key === "string") return state.key;
  const key = newKey();
  window.history.replaceState({ ...state, key }, "");
  return key;
}
/** State for a new history entry. */
export function newEntryState(): EntryState { return { key: newKey() }; }
/** State that keeps the current entry's key when its address is replaced. */
export function replacedEntryState(): EntryState { return { ...currentState(), key: entryKey() }; }

export function rememberScroll(): void {
  const key = entryKey();
  positions.delete(key);
  positions.set(key, Math.round(window.scrollY));
  if (positions.size > MAX_ENTRIES) positions.delete(positions.keys().next().value!);
  persist();
}
export function savedScroll(): number | undefined { return positions.get(entryKey()); }

/** Scrolls to `target`, retrying each frame while content is still loading; stops when reached, after
 *  `timeoutMs`, or as soon as the user scrolls, clicks or presses a key. Returns a cancel function. */
export function restoreScroll(target: number, timeoutMs = 3000): () => void {
  const started = performance.now();
  let frame = 0, done = false;
  const stop = () => {
    if (done) return;
    done = true;
    window.cancelAnimationFrame(frame);
    for (const type of USER_EVENTS) window.removeEventListener(type, stop, true);
  };
  const step = () => {
    window.scrollTo(0, target);
    if (Math.abs(window.scrollY - target) <= 1 || performance.now() - started > timeoutMs) stop();
    else frame = window.requestAnimationFrame(step);
  };
  for (const type of USER_EVENTS) window.addEventListener(type, stop, { capture: true, passive: true });
  step();
  return stop;
}
const USER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
