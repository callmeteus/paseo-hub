import { realpath } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";
import type { Database } from "../db/types.js";
import { expandInstructionRoot } from "../workflows/prompt-instructions.js";
import { AutomationSyncError } from "./contract.js";
import { automationFileText, gitBlobSha, readAutomationDirectory } from "./files.js";

export interface SnapshotBlob {
  path: string;
  sha: string;
  content: string;
}

const TRIGGER_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/u;
const DEFAULT_REPOSITORY_DIRECTORY = ".paseo/automations";

/**
 * A path inside the repository. Empty means `.paseo/automations`.
 * This is not a directory on the Hub machine.
 */
export function repositoryAutomationDirectory(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  const directory = trimmed.length === 0 ? DEFAULT_REPOSITORY_DIRECTORY : trimmed;
  if (!isRepositoryDirectory(directory)) {
    throw new AutomationSyncError(
      "The directory is a path inside the repository, like .paseo/automations.",
    );
  }
  return directory;
}

/**
 * One snapshot for the git commit: trigger YAML from Hub plus the prompt files.
 * Prompt files are read from the directory the automations already name, and written
 * under `repositoryDirectory` in the repository.
 */
export async function collectAutomationSnapshot(
  database: Pick<Database, "listOrganizationTriggers" | "findOrganizationTriggerRevision">,
  organizationId: string,
  repositoryDirectory: string,
): Promise<SnapshotBlob[]> {
  const triggers = await database.listOrganizationTriggers(organizationId);
  const revisions = await loadRevisions(database, triggers);
  const localDirectory = await sharedInstructionRoot(revisions.map((revision) => revision.yaml));
  const directory =
    localDirectory === undefined ? [] : await readAutomationDirectory(localDirectory);
  const files = directory.map((file) =>
    blob(`${repositoryDirectory}/${file.path}`, file.bytes, file.path),
  );
  for (const revision of revisions) {
    if (!TRIGGER_FILE_NAME.test(revision.name)) {
      throw new Error(`trigger name is not a safe file name: ${revision.name}`);
    }
    const bytes = Buffer.from(revision.yaml, "utf8");
    files.push(blob(`.paseo/triggers/${revision.name}.yml`, bytes, revision.name));
  }
  return files;
}

/** Files the daemon writes under `.paseo/automations/` in the run directory. */
export async function automationFilesForDelivery(
  automationsDirectory: string,
): Promise<{ path: string; content: string }[]> {
  const files = await readAutomationDirectory(automationsDirectory);
  return files.map((file) => ({
    path: file.path,
    content: automationFileText(file.bytes, file.path),
  }));
}

async function loadRevisions(
  database: Pick<Database, "findOrganizationTriggerRevision">,
  triggers: readonly { id: string; name: string; activeRevisionId: string }[],
): Promise<{ name: string; yaml: string }[]> {
  return Promise.all(
    triggers.map(async (trigger) => {
      const revision = await database.findOrganizationTriggerRevision(
        trigger.id,
        trigger.activeRevisionId,
      );
      if (revision === undefined) {
        throw new Error(`trigger ${trigger.name} has no active revision`);
      }
      return { name: trigger.name, yaml: revision.yaml };
    }),
  );
}

/**
 * The directory the commit copies.
 *
 * A catalog such as `regras/` names a folder inside the automations directory, and `~` can be a
 * symlink to that same directory. Those are one folder: the outer path. Separate trees stay an
 * error, because the commit has one destination.
 */
async function sharedInstructionRoot(documents: readonly string[]): Promise<string | undefined> {
  const expanded = new Set<string>();
  for (const document of documents) {
    for (const root of instructionRoots(document)) {
      const value = expandInstructionRoot(root);
      if (value.length > 0) expanded.add(value);
    }
  }
  if (expanded.size === 0) return undefined;
  const resolved = new Set<string>();
  for (const root of expanded) resolved.add(await existingDirectory(root));
  const directory = containingDirectory([...resolved]);
  if (directory === undefined) {
    throw new AutomationSyncError(
      "These automations read prompt files from more than one directory, so they can't be copied as one folder.",
    );
  }
  return directory;
}

async function existingDirectory(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch (error) {
    throw new AutomationSyncError(`Hub can't read the prompt directory ${root}.`, { cause: error });
  }
}

/** The named directory that contains every other one, after symlinks are resolved. */
function containingDirectory(directories: readonly string[]): string | undefined {
  return directories.find((candidate) =>
    directories.every((directory) => isSameOrInside(candidate, directory)),
  );
}

function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function instructionRoots(yaml: string): string[] {
  let value: unknown;
  try {
    value = load(yaml);
  } catch {
    return [];
  }
  const roots: string[] = [];
  collectRoots(value, roots);
  return roots;
}

function collectRoots(value: unknown, roots: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRoots(item, roots);
    return;
  }
  const object = record(value);
  if (object === undefined) return;
  const includeRoot = nestedRoot(object["include"]);
  const loadRoot = nestedRoot(object["load"]);
  if (includeRoot !== undefined) roots.push(includeRoot);
  if (loadRoot !== undefined) roots.push(loadRoot);
  for (const child of Object.values(object)) collectRoots(child, roots);
}

function nestedRoot(value: unknown): string | undefined {
  const object = record(value);
  if (object === undefined) return undefined;
  const root = object["root"];
  return typeof root === "string" ? root : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function isRepositoryDirectory(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\0")) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function blob(repoPath: string, bytes: Buffer, label: string): SnapshotBlob {
  return {
    path: repoPath,
    sha: gitBlobSha(bytes),
    content: automationFileText(bytes, label),
  };
}
