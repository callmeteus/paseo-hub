/**
 * Callback paths a provider may send back to Hub.
 * Anything else is refused so a handoff cannot navigate the embedded window elsewhere.
 */
const CONNECTION_CALLBACK_PATHS = new Set([
  "/api/integrations/github/setup",
  "/api/integrations/github/callback",
  "/api/integrations/discord/callback",
  "/api/integrations/slack/callback",
  "/api/integrations/linear/callback",
]);

/** Marks a connection attempt that the Paseo window started and must finish. */
export const EMBEDDED_CONNECTION_STATE_PREFIX = "ew.";

/**
 * Whether this OAuth state belongs to a connection started inside Paseo.
 *
 * @param state - The `state` query the provider sent back.
 * @returns True when the state carries the embedded prefix.
 */
export function isEmbeddedConnectionState(state: string): boolean {
  return state.startsWith(EMBEDDED_CONNECTION_STATE_PREFIX);
}

/**
 * Prefixes a random token so the callback can be recognized without a schema change.
 *
 * @param token - Unguessable token from `newConnectionState`.
 * @returns The same token, marked as started inside Paseo.
 */
export function embeddedConnectionState(token: string): string {
  return `${EMBEDDED_CONNECTION_STATE_PREFIX}${token}`;
}

/**
 * Whether a path is one of the provider callback routes.
 *
 * @param path - Path plus query, never an absolute URL.
 * @returns True when the embedded window may navigate there.
 */
export function isConnectionCallbackPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(path, "http://hub.local");
  } catch {
    return false;
  }
  if (url.origin !== "http://hub.local") {
    return false;
  }

  return CONNECTION_CALLBACK_PATHS.has(url.pathname);
}
