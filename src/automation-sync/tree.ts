const DEFAULT_MANAGED_PREFIXES = [".paseo/triggers/", ".paseo/automations/"] as const;

export interface RemoteBlob {
  path: string;
  sha: string;
}

export interface LocalBlob {
  path: string;
  sha: string;
  content: string;
}

export type TreeChange =
  | { path: string; mode: "100644"; type: "blob"; content: string }
  | { path: string; mode: "100644"; type: "blob"; sha: null };

export function isManagedAutomationPath(
  filePath: string,
  prefixes: readonly string[] = DEFAULT_MANAGED_PREFIXES,
): boolean {
  return prefixes.some((prefix) => filePath.startsWith(prefix));
}

/**
 * Changes under the trigger prefix and the automations directory in the repository.
 * A remote file in those prefixes that is no longer local is deleted. The rest of the repository stays.
 */
export function planAutomationTree(
  remote: readonly RemoteBlob[],
  local: readonly LocalBlob[],
  prefixes: readonly string[] = DEFAULT_MANAGED_PREFIXES,
): TreeChange[] {
  const localByPath = new Map(local.map((file) => [file.path, file]));
  const remotePaths = new Set<string>();
  const changes: TreeChange[] = [];
  for (const blob of remote) {
    if (!isManagedAutomationPath(blob.path, prefixes)) continue;
    remotePaths.add(blob.path);
    const next = localByPath.get(blob.path);
    if (next === undefined) {
      changes.push({ path: blob.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    if (next.sha !== blob.sha) {
      changes.push({ path: next.path, mode: "100644", type: "blob", content: next.content });
    }
  }
  for (const file of local) {
    if (!isManagedAutomationPath(file.path, prefixes)) continue;
    if (remotePaths.has(file.path)) continue;
    changes.push({ path: file.path, mode: "100644", type: "blob", content: file.content });
  }
  return changes;
}
