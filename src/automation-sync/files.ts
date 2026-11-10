import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { expandInstructionRoot } from "../workflows/prompt-instructions.js";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 5_000_000;

export class AutomationFilesError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AutomationFilesError";
  }
}

export interface AutomationFile {
  /** Path relative to the automations directory, with `/` separators. */
  path: string;
  bytes: Buffer;
}

/** Git blob id for the exact bytes that would be committed. */
export function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${String(bytes.byteLength)}\0`)
    .update(bytes)
    .digest("hex");
}

/**
 * The directory whose files go to the agent machine.
 * Every include in the run has to name the same root. The git setting is a path
 * inside the repository, so it is not a place to read on this machine.
 */
export function automationDirectoryForLaunch(
  instructions: readonly { root: string }[] | undefined,
): string | undefined {
  const roots = new Set(
    (instructions ?? []).map((item) => item.root.trim()).filter((root) => root.length > 0),
  );
  if (roots.size !== 1) return undefined;
  return expandHome([...roots][0] ?? "");
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

/** Reads the automations directory. `logs/` is left out. A symlink that leaves the directory is refused. */
export async function readAutomationDirectory(root: string): Promise<AutomationFile[]> {
  const expanded = expandInstructionRoot(root);
  if (!path.isAbsolute(expanded)) {
    throw new AutomationFilesError("automations directory must be an absolute path");
  }
  let realRoot: string;
  try {
    realRoot = await realpath(expanded);
  } catch (error) {
    throw new AutomationFilesError(`automations directory does not exist: ${expanded}`, {
      cause: error,
    });
  }
  const rootStat = await stat(realRoot);
  if (!rootStat.isDirectory()) {
    throw new AutomationFilesError(`automations directory is not a directory: ${expanded}`);
  }
  const files: AutomationFile[] = [];
  let total = 0;
  await walk(realRoot, realRoot, files, (bytes) => {
    total += bytes;
    if (files.length > MAX_FILES) {
      throw new AutomationFilesError(
        `automations directory has more than ${String(MAX_FILES)} files`,
      );
    }
    if (total > MAX_TOTAL_BYTES) {
      throw new AutomationFilesError("automations directory is larger than 5 MB");
    }
  });
  return files;
}

async function walk(
  root: string,
  directory: string,
  files: AutomationFile[],
  account: (bytes: number) => void,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "logs") continue;
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const real = await realpath(full);
      assertInside(root, real);
      const info = await stat(real);
      if (info.isDirectory()) await walk(root, real, files, account);
      else if (info.isFile()) await addFile(root, real, files, account);
      continue;
    }
    if (entry.isDirectory()) {
      await walk(root, full, files, account);
      continue;
    }
    if (entry.isFile()) await addFile(root, full, files, account);
  }
}

async function addFile(
  root: string,
  file: string,
  files: AutomationFile[],
  account: (bytes: number) => void,
): Promise<void> {
  const real = await realpath(file);
  assertInside(root, real);
  const bytes = await readFile(real);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new AutomationFilesError(
      `automation file is larger than 1 MB: ${relativePath(root, real)}`,
    );
  }
  const relative = relativePath(root, real);
  if (relative.length > 512) {
    throw new AutomationFilesError(`automation file path is too long: ${relative}`);
  }
  account(bytes.byteLength);
  files.push({ path: relative, bytes });
}

function assertInside(root: string, real: string): void {
  const escaped = path.relative(root, real);
  if (escaped.startsWith("..") || path.isAbsolute(escaped)) {
    throw new AutomationFilesError("automation file escapes its directory");
  }
}

function relativePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

export function automationFileText(bytes: Buffer, filePath: string): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new AutomationFilesError(`automation file is not UTF-8: ${filePath}`);
  }
  return text;
}
