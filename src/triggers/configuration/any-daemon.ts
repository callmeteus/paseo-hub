import type { DaemonRecord } from "../../db/types.js";

/** Authored `run.target.daemon` and the compiled daemon id while the run is not pinned. */
export const ANY_DAEMON = "*";

export function isAnyDaemonTarget(daemon: string | undefined): boolean {
  return daemon === ANY_DAEMON;
}

/** The label in the daemon menu and the automation list. */
export function daemonAffinityLabel(daemon: string): string {
  return isAnyDaemonTarget(daemon) ? "Any" : daemon;
}

export class AnyDaemonUnavailable extends Error {
  constructor() {
    super("no connected daemon can run this automation");
    this.name = "AnyDaemonUnavailable";
  }
}

/**
 * The daemon a run uses when the automation is not pinned.
 * Connected daemons that can execute, in slug order, so the choice is stable.
 */
export function pickDispatchDaemon(
  daemons: readonly Pick<DaemonRecord, "id" | "slug" | "status" | "presence" | "permissions">[],
  canDispatch?: (daemonId: string) => boolean,
): { id: string; slug: string } | undefined {
  const chosen = daemons
    .filter(
      (daemon) =>
        daemon.status === "active" &&
        daemon.presence === "connected" &&
        daemon.permissions.includes("hub.execute") &&
        canDispatch?.(daemon.id) !== false,
    )
    .sort((left, right) => left.slug.localeCompare(right.slug))[0];
  return chosen === undefined ? undefined : { id: chosen.id, slug: chosen.slug };
}

export async function launchDaemonTarget(
  environment: { daemon: string; daemonId: string },
  pickAnyDaemon: (() => Promise<{ id: string; slug: string } | undefined>) | undefined,
): Promise<{ daemonId: string; authoredSlug: string }> {
  if (!isAnyDaemonTarget(environment.daemon) && !isAnyDaemonTarget(environment.daemonId)) {
    return { daemonId: environment.daemonId, authoredSlug: environment.daemon };
  }
  const chosen = await pickAnyDaemon?.();
  if (chosen === undefined) throw new AnyDaemonUnavailable();
  return { daemonId: chosen.id, authoredSlug: chosen.slug };
}
