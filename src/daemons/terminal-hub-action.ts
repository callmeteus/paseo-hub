/**
 * What Hub asks the daemon to do once an execution is finished.
 *
 * A run that named a worktree archives. Archive is the existing daemon action,
 * and the daemon removes the worktree that run created. It leaves the checkout
 * in `cwd` alone, and it leaves a worktree another workspace still has open.
 * A run without a worktree keeps the previous rule: archive only when
 * auto-archive is on, interrupt a failure, and leave a success in place.
 *
 * @param execution - Execution whose launch intent may name a worktree
 * @param status - Terminal status Hub is recording
 * @returns The daemon action, or null when no daemon owns the run
 */
export function terminalHubAction(
  execution: {
    daemonId: string | null;
    launchIntent: {
      autoArchive: boolean;
      environment: { worktree?: unknown };
    } | null;
  },
  status: "succeeded" | "failed",
): "archive" | "interrupt" | null {
  if (execution.daemonId === null) return null;
  if (executionRequestedWorktree(execution.launchIntent)) return "archive";
  if (execution.launchIntent?.autoArchive === true) return "archive";
  return status === "failed" ? "interrupt" : null;
}

/**
 * Whether this launch asked the daemon to create a worktree for the run.
 *
 * @param intent - Persisted launch intent, when the execution has one
 * @returns True when `environment.worktree` is present
 */
function executionRequestedWorktree(
  intent: { environment?: { worktree?: unknown } } | null,
): boolean {
  const worktree = intent?.environment?.worktree;
  return worktree !== undefined && worktree !== null;
}
