import { createHash } from "node:crypto";
import { isConnectionCallbackPath, isEmbeddedConnectionState } from "./callback-path.js";

const HANDOFF_LIFETIME_MS = 10 * 60 * 1000;

interface RememberedAttempt {
  sessionId: string;
  expiresAt: number;
}

interface ParkedCallback {
  path: string;
  expiresAt: number;
}

/**
 * Holds a provider callback until the Paseo window that started it can load it.
 *
 * The system browser that GitHub sends back has no Hub session. The attempt was
 * started by the embedded window, so the callback is parked for that session
 * instead of being completed, or refused, in the signed-out browser.
 */
export namespace EmbeddedConnectionHandoff {
  const attempts = new Map<string, RememberedAttempt>();
  const parked = new Map<string, ParkedCallback>();

  /**
   * Whether this request is the embedded Paseo window.
   *
   * @param request - The browser request that started or finished a connection.
   * @returns True when the user agent is Electron.
   */
  export function startedInApp(request: Request): boolean {
    return (request.headers.get("user-agent") ?? "").includes("Electron");
  }

  /**
   * Remembers that this state must be finished by `sessionId`.
   *
   * @param state - Full OAuth state, including the embedded prefix.
   * @param sessionId - Hub session that started the connection.
   * @param expiresAt - Epoch milliseconds after which the handoff is refused.
   * @returns Nothing.
   */
  export function remember(
    state: string,
    sessionId: string,
    expiresAt = Date.now() + HANDOFF_LIFETIME_MS,
  ): void {
    attempts.set(hash(state), { sessionId, expiresAt });
  }

  /**
   * Parks the callback URL for the session that started it.
   *
   * A request that is already inside Paseo is left alone, so the window that
   * loads the parked URL does not park it again.
   *
   * @param request - The provider callback, as the system browser sent it.
   * @returns True when the response should be the close-this-tab page.
   */
  export function park(request: Request): boolean {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    if (state === null || !isEmbeddedConnectionState(state)) {
      return false;
    }
    if (startedInApp(request)) {
      return false;
    }

    const path = `${url.pathname}${url.search}`;
    if (!isConnectionCallbackPath(path)) {
      return false;
    }

    const attempt = attempts.get(hash(state));
    if (attempt === undefined || attempt.expiresAt <= Date.now()) {
      return false;
    }

    parked.set(attempt.sessionId, { path, expiresAt: attempt.expiresAt });
    return true;
  }

  /**
   * Takes the callback the embedded window should load, once.
   *
   * @param sessionId - Session of the window that is polling.
   * @returns The callback path, or null when nothing is waiting.
   */
  export function take(sessionId: string): string | null {
    const callback = parked.get(sessionId);
    if (callback === undefined) {
      return null;
    }
    parked.delete(sessionId);
    if (callback.expiresAt <= Date.now()) {
      return null;
    }
    return callback.path;
  }

  /**
   * The page the system browser shows while Paseo finishes the connection.
   *
   * @returns An HTML document with no callback secrets in it.
   */
  export function page(): Response {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Return to Paseo</title>
</head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#111;color:#f5f5f5">
  <p>You can close this tab. Paseo will finish connecting.</p>
</body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  /**
   * Drops every parked callback. Tests use this so one file cannot leak into another.
   *
   * @returns Nothing.
   */
  export function reset(): void {
    attempts.clear();
    parked.clear();
  }
}

/**
 * Hashes an OAuth state the same way the connection attempt is stored.
 *
 * @param state - Raw state from the start request or the provider callback.
 * @returns SHA-256 hex digest.
 */
function hash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}
