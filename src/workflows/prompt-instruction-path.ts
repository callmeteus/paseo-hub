/**
 * Paths an automation may import into its prompt.
 *
 * The path is relative to the automation working directory, or to a root the
 * YAML names. Nothing is read here. The launch reads the file, and only from
 * inside that root.
 */

export class PromptInstructionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PromptInstructionError";
  }
}

export type RuntimePromptInclude =
  | { kind: "include"; path: string }
  | { kind: "include"; path: string; root: string };

/**
 * Checks a prompt include path and returns its canonical relative form.
 *
 * @param value - Path as written in the automation YAML
 * @returns Segments joined with `/`, with no `.` or `..`
 */
export function validatePromptInstructionPath(value: string): string {
  if (value.includes("\0")) {
    throw new PromptInstructionError("instruction path contains a null byte");
  }
  const normalized = value.replaceAll("\\", "/").trim();
  if (normalized.length === 0) {
    throw new PromptInstructionError("instruction path is empty");
  }
  if (normalized.startsWith("/") || /^[a-zA-Z]:/u.test(normalized)) {
    throw new PromptInstructionError("instruction path must be relative to its root");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new PromptInstructionError(
      "instruction path must not contain empty, '.' or '..' segments",
    );
  }
  return segments.join("/");
}

/**
 * Accepts an absolute root, or `~` / `~/...` expanded later from the home directory.
 *
 * @param value - Root as written in the automation YAML
 */
export function assertInstructionRoot(value: string): void {
  if (value.includes("\0")) {
    throw new PromptInstructionError("instruction root contains a null byte");
  }
  if (value === "~" || value.startsWith("~/")) return;
  if (value.startsWith("/")) return;
  throw new PromptInstructionError("instruction root must be an absolute path");
}

/**
 * Turns one YAML include into the compiled block the launch will read.
 *
 * @param include - A path relative to the working directory, or a path plus a root
 * @returns The include block stored on the compiled step
 */
export function compileRuntimePromptInclude(
  include: string | { path: string; root?: string | undefined },
): RuntimePromptInclude {
  const target = typeof include === "string" ? { path: include } : include;
  const path = validatePromptInstructionPath(target.path);
  if (target.root !== undefined) {
    assertInstructionRoot(target.root);
    return { kind: "include", path, root: target.root };
  }
  return { kind: "include", path };
}
