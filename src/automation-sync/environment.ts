import { readFile } from "node:fs/promises";
import { z } from "zod";

/** Inline JSON that declares the automation git sync applied on every boot. */
export const AUTOMATION_GIT_SYNC_ENVIRONMENT_VARIABLE = "PASEO_HUB_AUTOMATION_GIT_SYNC";
/** Path of the JSON file that declares the same sync. Takes over when the inline value is absent. */
export const AUTOMATION_GIT_SYNC_FILE_ENVIRONMENT_VARIABLE = "PASEO_HUB_AUTOMATION_GIT_SYNC_FILE";

/** Intervals the panel offers, so a declaration cannot store one the worker never uses. */
export const DECLARED_SYNC_INTERVALS = [5, 15, 60] as const;

export interface ConfiguredAutomationGitSync {
  /** Organization slug, id, or a name that matches exactly one organization. */
  organization: string;
  /** Slug of the GitHub connection that owns the repository. */
  connection: string;
  /** Repository as `owner/name`. */
  repository: string;
  /** Branch to publish to. Defaults to the repository's default branch. */
  branch?: string;
  /** Directory inside the repository. Defaults to `.paseo/automations`. */
  directory?: string;
  /** Worker interval in minutes. Defaults to 15. */
  intervalMinutes?: (typeof DECLARED_SYNC_INTERVALS)[number];
  /** Commit message. Defaults to the Hub's generic message. */
  commitMessage?: string;
  /** Off by default only when declared; a declaration is on unless it says otherwise. */
  enabled?: boolean;
}

const directorySchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u)
  .refine((value) => !value.split("/").includes(".."), "directory cannot leave the repository");

const repositorySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u, "repository must be owner/name");

const syncSchema = z
  .object({
    organization: z.string().trim().min(1),
    connection: z.string().trim().min(1),
    repository: repositorySchema,
    branch: z.string().trim().min(1).max(250).optional(),
    directory: directorySchema.optional(),
    intervalMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]).optional(),
    commitMessage: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

// One declaration is the common case, so a bare object is accepted beside the list form.
const documentSchema = z.union([syncSchema, z.array(syncSchema).min(1)]);

export class AutomationGitSyncConfigurationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AutomationGitSyncConfigurationError";
  }
}

/**
 * Reads the automation sync declarations for this instance.
 *
 * Both variables are optional: with neither set the feature is off and the Hub keeps whatever the
 * panel saved. The inline value wins, and declaring both is an error so a stale file cannot
 * silently shadow the environment.
 *
 * @param environment - Process environment
 * @returns Declared syncs, in declaration order
 */
export async function readConfiguredAutomationGitSyncs(
  environment: Record<string, string | undefined>,
): Promise<readonly ConfiguredAutomationGitSync[]> {
  const inline = nonEmpty(environment[AUTOMATION_GIT_SYNC_ENVIRONMENT_VARIABLE]);
  const file = nonEmpty(environment[AUTOMATION_GIT_SYNC_FILE_ENVIRONMENT_VARIABLE]);
  if (inline !== undefined && file !== undefined) {
    throw new AutomationGitSyncConfigurationError(
      `${AUTOMATION_GIT_SYNC_ENVIRONMENT_VARIABLE} and ${AUTOMATION_GIT_SYNC_FILE_ENVIRONMENT_VARIABLE} cannot both be set`,
    );
  }
  const document =
    inline ??
    (file === undefined
      ? undefined
      : await readFile(file, "utf8").catch((error: unknown) => {
          throw new AutomationGitSyncConfigurationError(
            `could not read ${AUTOMATION_GIT_SYNC_FILE_ENVIRONMENT_VARIABLE}`,
            { cause: error },
          );
        }));
  if (document === undefined) return [];
  return parseConfiguredAutomationGitSyncs(document);
}

/**
 * Parses the declaration document. A malformed entry rejects the whole document, so a typo is
 * reported at boot instead of looking like a sync that simply has not been configured yet.
 *
 * @param document - JSON text or an already parsed value
 * @returns Declared syncs
 */
export function parseConfiguredAutomationGitSyncs(
  document: unknown,
): readonly ConfiguredAutomationGitSync[] {
  const parsedDocument = typeof document === "string" ? safeJson(document) : document;
  const parsed = documentSchema.safeParse(parsedDocument);
  if (!parsed.success) {
    throw new AutomationGitSyncConfigurationError(
      "automation git sync declaration must be one object or a non-empty array of them, with organization, connection and repository",
    );
  }
  const entries = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  return entries.map((entry) => {
    const declared: ConfiguredAutomationGitSync = {
      organization: entry.organization,
      connection: entry.connection,
      repository: entry.repository,
    };
    if (entry.branch !== undefined) declared.branch = entry.branch;
    if (entry.directory !== undefined) declared.directory = entry.directory;
    if (entry.intervalMinutes !== undefined) declared.intervalMinutes = entry.intervalMinutes;
    if (entry.commitMessage !== undefined) declared.commitMessage = entry.commitMessage;
    if (entry.enabled !== undefined) declared.enabled = entry.enabled;
    return declared;
  });
}

function safeJson(document: string): unknown {
  try {
    return JSON.parse(document);
  } catch (error) {
    throw new AutomationGitSyncConfigurationError("automation git sync JSON is invalid", {
      cause: error,
    });
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
