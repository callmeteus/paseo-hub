import { readdir, realpath, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { MAX_PROMPT_PARTIAL_CONTENT_BYTES } from "../config/prompt-partial-limits.js";
import type { CompiledPromptBlock } from "../config/compiler.js";
import type { LaunchInstruction } from "../dispatcher/launch-machine-intent.js";
import {
  ExpressionEvaluationError,
  ExpressionSyntaxError,
  renderExpressionTemplate,
  type ExpressionContext,
} from "./expression.js";
import {
  assertInstructionRoot,
  PromptInstructionError,
  validatePromptInstructionPath,
} from "./prompt-instruction-path.js";

export { PromptInstructionError } from "./prompt-instruction-path.js";

export interface PromptInstructionRequest {
  /** Automation working directory. Used when the include does not name a root. */
  cwd: string;
  /** Relative instruction path from the automation YAML. */
  path: string;
  /** Absolute root, or `~` / `~/...`, when the file is outside the working directory. */
  root?: string;
}

export type PromptInstructionReader = (request: PromptInstructionRequest) => Promise<string>;

/** The same sentence for every agent that declares a load catalog. */
export const LOAD_INSTRUCTION_PROSE =
  "Instruction files for this run. When one line describes the case, call load_instruction with that path and follow the file. When none match, do not call it.";

// The catalog line is the file's first sentence. 400 keeps a channel exception at the end of
// the lines that already live in regras/.
const INSTRUCTION_WHEN_LIMIT = 400;

export interface ComposedLaunchPrompt {
  prompt: string;
  instructions: readonly LaunchInstruction[];
}

/**
 * Reads one instruction file for a prompt include.
 *
 * The file has to stay inside the working directory, or inside the root the
 * YAML named. A symlink that points outside that directory is refused.
 *
 * @param request - Working directory, relative path, and optional root
 * @returns The file text
 */
export async function readPromptInstruction(request: PromptInstructionRequest): Promise<string> {
  const relative = validatePromptInstructionPath(request.path);
  const root = request.root === undefined ? request.cwd : expandInstructionRoot(request.root);
  if (!path.isAbsolute(root)) {
    throw new PromptInstructionError("instruction root must be absolute");
  }
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch (error) {
    throw new PromptInstructionError(`instruction root does not exist: ${root}`, { cause: error });
  }
  const rootStat = await stat(rootReal);
  if (!rootStat.isDirectory()) {
    throw new PromptInstructionError(`instruction root is not a directory: ${root}`);
  }
  let fileReal: string;
  try {
    fileReal = await realpath(path.resolve(rootReal, relative));
  } catch (error) {
    throw new PromptInstructionError(`instruction file was not found: ${relative}`, {
      cause: error,
    });
  }
  const escaped = path.relative(rootReal, fileReal);
  if (escaped.startsWith("..") || path.isAbsolute(escaped)) {
    throw new PromptInstructionError(`instruction file escapes its root: ${relative}`);
  }
  const fileStat = await stat(fileReal);
  if (!fileStat.isFile()) {
    throw new PromptInstructionError(`instruction path is not a file: ${relative}`);
  }
  const content = await readFile(fileReal, "utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_PROMPT_PARTIAL_CONTENT_BYTES) {
    throw new PromptInstructionError(
      `instruction file exceeds the ${MAX_PROMPT_PARTIAL_CONTENT_BYTES}-byte limit: ${relative}`,
    );
  }
  return content;
}

/**
 * Joins prompt blocks in YAML order, reading each include from disk.
 *
 * A load block becomes the shared English catalog sentence plus one line per
 * file. The file body stays out of the prompt. Includes are explicit. A run
 * with only a string prompt never reads a rule file. Text and included files
 * both render `${{ }}` the same way as a workflow partial. Catalog lines stay
 * literal.
 *
 * @param input - Compiled blocks, the automation working directory, and the run context
 * @returns The prompt sent to the agent, and the files `load_instruction` may read
 */
export async function composeLaunchPrompt(input: {
  blocks: readonly CompiledPromptBlock[];
  cwd: string;
  context: ExpressionContext;
  read?: PromptInstructionReader;
}): Promise<ComposedLaunchPrompt> {
  const read = input.read ?? readPromptInstruction;
  const parts: string[] = [];
  const instructions: LaunchInstruction[] = [];
  const seen = new Set<string>();
  for (const block of input.blocks) {
    if (block.kind === "load") {
      const catalog = await readInstructionCatalog({
        cwd: input.cwd,
        root: block.root,
        read,
        seen,
      });
      parts.push(catalog.text);
      instructions.push(...catalog.instructions);
      continue;
    }
    const source = await promptBlockSource(block, input.cwd, read);
    try {
      parts.push(renderExpressionTemplate(source, input.context));
    } catch (error) {
      if (error instanceof ExpressionSyntaxError || error instanceof ExpressionEvaluationError) {
        const where = block.kind === "include" ? `instruction ${block.path}: ` : "";
        throw new PromptInstructionError(`${where}${error.message}`);
      }
      throw error;
    }
  }
  const prompt = parts.join("\n");
  if (prompt.trim().length === 0) {
    throw new PromptInstructionError("prompt is empty after importing instructions");
  }
  return { prompt, instructions };
}

/**
 * Splits an instruction file into the catalog line and the body a tool returns.
 *
 * Frontmatter `when` is the catalog line, and the body omits that block. Without
 * frontmatter, the catalog line is the first line and the body is the whole file.
 *
 * @param content - File text
 * @returns The catalog line, already cut to one line, and the body
 */
export function splitInstructionDocument(content: string): { when: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (match) {
    const when = frontmatterWhen(match[1] ?? "");
    const body = content.slice(match[0].length);
    return {
      when: when.length > 0 ? capInstructionWhen(when) : capInstructionWhen(firstLine(body)),
      body,
    };
  }
  return { when: capInstructionWhen(firstLine(content)), body: content };
}

async function promptBlockSource(
  block: CompiledPromptBlock,
  cwd: string,
  read: PromptInstructionReader,
): Promise<string> {
  if (block.kind === "text") return block.value;
  if (block.kind === "partial") return block.content;
  if (block.kind === "load") {
    throw new PromptInstructionError(
      `instruction catalog ${block.root} is expanded before the prompt is rendered`,
    );
  }
  try {
    return await read({
      cwd,
      path: block.path,
      ...(block.root === undefined ? {} : { root: block.root }),
    });
  } catch (error) {
    if (error instanceof PromptInstructionError) throw error;
    const detail = error instanceof Error ? error.message : "unreadable instruction";
    throw new PromptInstructionError(`instruction ${block.path}: ${detail}`);
  }
}

async function readInstructionCatalog(input: {
  cwd: string;
  root: string;
  read: PromptInstructionReader;
  seen: Set<string>;
}): Promise<{ text: string; instructions: LaunchInstruction[] }> {
  const names = await listCatalogFiles(input.root);
  if (names.length === 0) {
    throw new PromptInstructionError(`instruction catalog is empty: ${input.root}`);
  }
  const instructions: LaunchInstruction[] = [];
  const lines: string[] = [];
  for (const name of names) {
    if (input.seen.has(name)) {
      throw new PromptInstructionError(`instruction catalog path is repeated: ${name}`);
    }
    input.seen.add(name);
    let content: string;
    try {
      content = await input.read({ cwd: input.cwd, path: name, root: input.root });
    } catch (error) {
      if (error instanceof PromptInstructionError) throw error;
      const detail = error instanceof Error ? error.message : "unreadable instruction";
      throw new PromptInstructionError(`instruction ${name}: ${detail}`);
    }
    const when = splitInstructionDocument(content).when;
    if (when.length === 0) {
      throw new PromptInstructionError(`instruction file has no when: ${name}`);
    }
    instructions.push({ path: name, root: input.root });
    lines.push(`- ${name} — ${when}`);
  }
  return {
    text: `${LOAD_INSTRUCTION_PROSE}\n\n${lines.join("\n")}`,
    instructions,
  };
}

async function listCatalogFiles(root: string): Promise<string[]> {
  const expanded = expandInstructionRoot(root);
  let rootReal: string;
  try {
    rootReal = await realpath(expanded);
  } catch (error) {
    throw new PromptInstructionError(`instruction root does not exist: ${expanded}`, {
      cause: error,
    });
  }
  const rootStat = await stat(rootReal);
  if (!rootStat.isDirectory()) {
    throw new PromptInstructionError(`instruction root is not a directory: ${expanded}`);
  }
  const entries = await readdir(rootReal, { withFileTypes: true });
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && isCatalogName(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function isCatalogName(name: string): boolean {
  return !name.startsWith(".") && name.endsWith(".md");
}

function frontmatterWhen(block: string): string {
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("when:")) return line.slice("when:".length).trim();
  }
  return "";
}

function firstLine(content: string): string {
  return (
    content
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

function capInstructionWhen(value: string): string {
  const single = value.replace(/\s+/gu, " ").trim();
  return single.length > INSTRUCTION_WHEN_LIMIT
    ? single.slice(0, INSTRUCTION_WHEN_LIMIT).trimEnd()
    : single;
}

export function expandInstructionRoot(value: string): string {
  assertInstructionRoot(value);
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}
