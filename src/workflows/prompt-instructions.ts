import { realpath, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { MAX_PROMPT_PARTIAL_CONTENT_BYTES } from "../config/prompt-partial-limits.js";
import type { CompiledPromptBlock } from "../config/compiler.js";
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
 * Includes are explicit. A run with only a string prompt never reads a rule
 * file. Text and included files both render `${{ }}` the same way as a
 * workflow partial.
 *
 * @param input - Compiled blocks, the automation working directory, and the run context
 * @returns The prompt sent to the agent
 */
export async function composeLaunchPrompt(input: {
  blocks: readonly CompiledPromptBlock[];
  cwd: string;
  context: ExpressionContext;
  read?: PromptInstructionReader;
}): Promise<string> {
  const read = input.read ?? readPromptInstruction;
  const parts: string[] = [];
  for (const block of input.blocks) {
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
  return prompt;
}

async function promptBlockSource(
  block: CompiledPromptBlock,
  cwd: string,
  read: PromptInstructionReader,
): Promise<string> {
  if (block.kind === "text") return block.value;
  if (block.kind === "partial") return block.content;
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

function expandInstructionRoot(value: string): string {
  assertInstructionRoot(value);
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}
