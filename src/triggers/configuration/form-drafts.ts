import {
  GUARDRAIL_IDS,
  GuardrailSchema,
  type Guardrail,
  type GuardrailId,
} from "../../workflows/guardrails.js";
import {
  assertInstructionRoot,
  PromptInstructionError,
  validatePromptInstructionPath,
} from "../../workflows/prompt-instruction-path.js";
import type { TriggerPrompt } from "./schema.js";

/** One block of the instructions field. `root` is empty when the include uses the working directory. */
export type InstructionDraft =
  | { kind: "text"; text: string }
  | { kind: "include"; path: string; root: string };

/** One rail the form can add, remove, or retarget. `options` is empty or `{}`. */
export interface GuardrailDraft {
  id: string;
  /** Empty omits `options`. `{}` writes an empty object. Any other text is rejected. */
  options: string;
}

/** `run.target.worktree`. An empty `mode` means the run stays on the working directory. */
export interface WorktreeDraft {
  mode: "" | "branch-off" | "checkout-branch" | "checkout-pr";
  newBranch: string;
  base: string;
  branch: string;
  prNumber: string;
}

/** The worktree object the document stores. Absent when the field is empty. */
export type WorktreeDocument =
  | { mode: "branch-off"; newBranch: string; base?: string | undefined }
  | { mode: "checkout-branch"; branch: string }
  | { mode: "checkout-pr"; prNumber: number };

/**
 * A prompt string as the one text block the form already edits.
 *
 * @param text - Instruction text
 * @returns That text as the only block
 */
export function textInstructions(text: string): InstructionDraft[] {
  return [{ kind: "text", text }];
}

/**
 * No worktree. The run uses `cwd` and does not ask the daemon to create a checkout.
 *
 * @returns The empty worktree field
 */
export function emptyWorktree(): WorktreeDraft {
  return { mode: "", newBranch: "", base: "", branch: "", prNumber: "" };
}

/**
 * The instructions field for a prompt the document already parsed.
 *
 * A string is one text block. A list keeps YAML order: text, then an include path,
 * with `root` empty when the include did not name one.
 *
 * @param prompt - Authored prompt
 * @returns Blocks the form edits
 */
export function projectInstructions(prompt: TriggerPrompt): InstructionDraft[] {
  if (typeof prompt === "string") return textInstructions(prompt);
  return prompt.map((part) => {
    if ("text" in part) return { kind: "text", text: part.text };
    if (typeof part.include === "string") return { kind: "include", path: part.include, root: "" };
    return { kind: "include", path: part.include.path, root: part.include.root ?? "" };
  });
}

/**
 * Prompt YAML for these blocks.
 *
 * One text block stays a string, which is how a prompt without includes is stored.
 * Any include, or more than one block, is written as a list in the same order.
 *
 * @param parts - Blocks the form is saving
 * @returns The `prompt` value
 */
export function instructionsDocument(parts: readonly InstructionDraft[]): TriggerPrompt {
  const [only] = parts;
  if (parts.length === 1 && only?.kind === "text") return only.text;
  return parts.map((part) => {
    if (part.kind === "text") return { text: part.text };
    const path = part.path.trim();
    const root = part.root.trim();
    return root.length === 0 ? { include: path } : { include: { path, root } };
  });
}

/**
 * Why these instructions cannot be saved.
 *
 * @param parts - Blocks the form is saving
 * @returns The message, or undefined when the blocks are usable
 */
export function instructionError(parts: readonly InstructionDraft[]): string | undefined {
  if (parts.length === 0) return "Instructions are required.";
  let useful = false;
  for (const part of parts) {
    if (part.kind === "text") {
      if (part.text.trim().length > 0) useful = true;
      continue;
    }
    const path = part.path.trim();
    if (path.length === 0) return "Instruction file is required.";
    try {
      validatePromptInstructionPath(path);
      const root = part.root.trim();
      if (root.length > 0) assertInstructionRoot(root);
    } catch (error) {
      if (error instanceof PromptInstructionError) return error.message;
      return "Instruction file is invalid.";
    }
    useful = true;
  }
  return useful ? undefined : "Instructions are required.";
}

/**
 * Rails already stored on the run. An omitted list is an empty field.
 *
 * @param guardrails - `run.guardrails`, when the document has it
 * @returns One row per rail, in document order
 */
export function projectGuardrails(guardrails: readonly Guardrail[] | undefined): GuardrailDraft[] {
  if (guardrails === undefined) return [];
  return guardrails.map((rail) => ({
    id: rail.id,
    options: rail.options === undefined ? "" : "{}",
  }));
}

/**
 * `run.guardrails` for these rows. An empty field omits the key.
 *
 * @param drafts - Rows the form is saving
 * @returns The rails, or undefined when the field is empty
 */
export function guardrailsDocument(drafts: readonly GuardrailDraft[]): Guardrail[] | undefined {
  if (drafts.length === 0) return undefined;
  return drafts.map((draft) => {
    const parsed = parseGuardrailDraft(draft);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.value;
  });
}

/**
 * Why these rails cannot be saved.
 *
 * @param drafts - Rows the form is saving
 * @returns The message, or undefined when every row is a known rail
 */
export function guardrailError(drafts: readonly GuardrailDraft[]): string | undefined {
  for (const draft of drafts) {
    const parsed = parseGuardrailDraft(draft);
    if (!parsed.ok) return parsed.message;
  }
  return undefined;
}

/**
 * The worktree field for `run.target.worktree`.
 *
 * @param worktree - The target worktree, when the document has one
 * @returns The field, with unused mode inputs left blank
 */
export function projectWorktree(worktree: WorktreeDocument | undefined): WorktreeDraft {
  if (worktree === undefined) return emptyWorktree();
  if (worktree.mode === "branch-off") {
    return {
      mode: "branch-off",
      newBranch: worktree.newBranch,
      base: worktree.base ?? "",
      branch: "",
      prNumber: "",
    };
  }
  if (worktree.mode === "checkout-branch") {
    return {
      mode: "checkout-branch",
      newBranch: "",
      base: "",
      branch: worktree.branch,
      prNumber: "",
    };
  }
  return {
    mode: "checkout-pr",
    newBranch: "",
    base: "",
    branch: "",
    prNumber: String(worktree.prNumber),
  };
}

/**
 * `run.target.worktree` for this field. An empty mode omits the key.
 *
 * @param draft - Field the form is saving
 * @returns The worktree, or undefined when the run stays on the working directory
 */
export function worktreeDocument(draft: WorktreeDraft): WorktreeDocument | undefined {
  if (draft.mode === "") return undefined;
  if (draft.mode === "branch-off") {
    const newBranch = draft.newBranch.trim();
    if (newBranch.length === 0) throw new Error("New branch is required.");
    const base = draft.base.trim();
    return base.length === 0
      ? { mode: "branch-off", newBranch }
      : { mode: "branch-off", newBranch, base };
  }
  if (draft.mode === "checkout-branch") {
    const branch = draft.branch.trim();
    if (branch.length === 0) throw new Error("Branch is required.");
    return { mode: "checkout-branch", branch };
  }
  if (!/^[1-9]\d*$/u.test(draft.prNumber.trim())) {
    throw new Error("Pull request number must be a positive integer.");
  }
  return { mode: "checkout-pr", prNumber: Number(draft.prNumber.trim()) };
}

/**
 * Why this worktree cannot be saved.
 *
 * @param draft - Field the form is saving
 * @returns The message, or undefined when the field is empty or complete
 */
export function worktreeError(draft: WorktreeDraft): string | undefined {
  try {
    worktreeDocument(draft);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Worktree is invalid.";
  }
}

function parseGuardrailDraft(
  draft: GuardrailDraft,
): { ok: true; value: Guardrail } | { ok: false; message: string } {
  if (!isGuardrailId(draft.id)) return { ok: false, message: "Choose a guardrail." };
  const options = draft.options.trim();
  if (options.length === 0) {
    const parsed = GuardrailSchema.safeParse({ id: draft.id });
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, message: "Choose a guardrail." };
  }
  let parsedOptions: unknown;
  try {
    parsedOptions = JSON.parse(options);
  } catch {
    return { ok: false, message: "Guardrail options must be {} or left empty." };
  }
  const parsed = GuardrailSchema.safeParse({ id: draft.id, options: parsedOptions });
  if (!parsed.success) {
    return { ok: false, message: "This guardrail does not take those options." };
  }
  return { ok: true, value: parsed.data };
}

function isGuardrailId(value: string): value is GuardrailId {
  return (GUARDRAIL_IDS as readonly string[]).includes(value);
}
