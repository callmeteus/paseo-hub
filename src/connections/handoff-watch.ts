import { embeddedHubKeepsPage } from "../shell/external-url.js";
import { isConnectionCallbackPath } from "./callback-path.js";

const STORAGE_KEY = "paseo.connection-handoff";
const ARMED_SEARCH_KEY = "paseo.connection-handoff-search";
const INTERVAL_MS = 1000;
const LIFETIME_MS = 10 * 60 * 1000;

let takeHandoff: (() => Promise<string | null>) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let stopAt = 0;

/**
 * Starts waiting for the provider callback to come back to this window.
 *
 * Called when a connection leaves for the system browser. The website does not
 * wait: that browser is the one that will finish the redirect itself.
 *
 * @returns Nothing.
 */
export function armConnectionHandoff(): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!embeddedHubKeepsPage(window.navigator.userAgent)) {
    return;
  }

  window.sessionStorage.setItem(STORAGE_KEY, "1");
  window.sessionStorage.setItem(ARMED_SEARCH_KEY, window.location.search);
  stopAt = Date.now() + LIFETIME_MS;
  ensureTimer();
}

/**
 * Whether the address changed into a provider return after this attempt started.
 *
 * A return that was already on screen belongs to an older attempt, so it does
 * not finish the one that just left for the system browser.
 *
 * @param currentSearch - The page search string, including the leading `?` when present.
 * @param armedSearch - The search string captured when the attempt left this window.
 * @returns True when this attempt's return is on screen.
 */
export function connectionAttemptFinished(currentSearch: string, armedSearch: string): boolean {
  if (currentSearch === armedSearch) {
    return false;
  }

  const params = new URLSearchParams(currentSearch);
  return params.has("app") && params.has("result");
}

/**
 * Keeps the wait alive while the dashboard is mounted.
 *
 * @param take - Reads the parked callback for the current session. Null when none is waiting.
 * @returns Stops this mount from receiving later callbacks. The wait itself stays armed.
 */
export function watchConnectionHandoff(take: () => Promise<string | null>): () => void {
  takeHandoff = take;
  if (typeof window !== "undefined" && window.sessionStorage.getItem(STORAGE_KEY) === "1") {
    ensureTimer();
  }

  return () => {
    if (takeHandoff === take) {
      takeHandoff = undefined;
    }
  };
}

/**
 * Starts the poll when one is not already running.
 *
 * @returns Nothing.
 */
function ensureTimer(): void {
  if (timer !== undefined) {
    return;
  }
  if (stopAt === 0) {
    stopAt = Date.now() + LIFETIME_MS;
  }

  timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);
  void tick();
}

/**
 * Loads one parked callback in this window, which is the session that started it.
 *
 * @returns Nothing.
 */
async function tick(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }
  if (window.sessionStorage.getItem(STORAGE_KEY) !== "1") {
    stop();
    return;
  }
  if (Date.now() > stopAt) {
    clearArmedAttempt();
    stop();
    return;
  }
  if (
    connectionAttemptFinished(
      window.location.search,
      window.sessionStorage.getItem(ARMED_SEARCH_KEY) ?? "",
    )
  ) {
    clearArmedAttempt();
    stop();
    return;
  }

  const take = takeHandoff;
  if (take === undefined) {
    return;
  }

  let path: string | null = null;
  try {
    path = await take();
  } catch {
    // The next tick retries. One failed read must not drop the parked callback.
    return;
  }
  if (path === null || !isConnectionCallbackPath(path)) {
    return;
  }

  window.location.assign(path);
}

/**
 * Forgets the armed attempt. Called when the return arrives or the wait expires.
 *
 * @returns Nothing.
 */
function clearArmedAttempt(): void {
  window.sessionStorage.removeItem(STORAGE_KEY);
  window.sessionStorage.removeItem(ARMED_SEARCH_KEY);
}

/**
 * Stops polling. The session flag is cleared by the caller when the wait is over.
 *
 * @returns Nothing.
 */
function stop(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  stopAt = 0;
}
