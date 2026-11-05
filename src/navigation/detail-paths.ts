/**
 * Home's recent runs and the activity table open one run. A second detail page would show the
 * same record twice and drift the moment one of them learned a new field.
 */
export function runDetailPath(organizationSlug: string, runId: string): string {
  return `/o/${organizationSlug}/activity/${runId}`;
}

/**
 * A daemon row opens that daemon. The list where it is renamed or revoked stays `/daemons`,
 * so following the row is not a way to remove it.
 */
export function daemonDetailPath(organizationSlug: string, daemonId: string): string {
  return `/o/${organizationSlug}/daemons/${daemonId}`;
}
