import { z } from "zod";
import { createGitHubAuth } from "../auth/github.js";
import type { DatabaseRuntime, QueryRow } from "../db/runtime/index.js";
import { resolveOrganizationId } from "../organizations/resolution.js";
import type { Provider, ProviderApplicationConfiguration } from "../provider-applications/index.js";
import type { ConfiguredAutomationGitSync } from "./environment.js";
import { repositoryAutomationDirectory } from "./snapshot.js";

export interface AutomationGitSyncActivationFailure {
  organization: string;
  connection: string;
  error: unknown;
}

export interface ActivateAutomationGitSyncsOptions {
  database: DatabaseRuntime;
  syncs: readonly ConfiguredAutomationGitSync[];
  /** Applications read from the environment. The repository lookup needs the GitHub App. */
  applications: Partial<Record<Provider, ProviderApplicationConfiguration>>;
  /** HTTP stand-in used by tests. */
  fetch?: typeof fetch;
}

const githubRepositorySchema = z
  .object({
    id: z.number().int().positive(),
    full_name: z.string().min(1),
    default_branch: z.string().min(1),
  })
  .passthrough();

/**
 * Applies the automation git sync declarations of this instance.
 *
 * Runs on every boot and is idempotent. The connection is resolved by its slug, so a GitHub
 * connection that was recreated with a new id is still the one the row points at: the update
 * rewrites `github_connection_id` instead of leaving the row on a deleted connection. The
 * repository id comes from GitHub, because the worker refuses a row without it.
 *
 * Nothing is deleted when a declaration disappears, so turning the sync off stays an explicit
 * operator action.
 *
 * @param options - Database, declarations, environment applications and test doubles
 * @returns One failure entry per declaration that could not be applied
 */
export async function activateAutomationGitSyncsAtStartup(
  options: ActivateAutomationGitSyncsOptions,
): Promise<readonly AutomationGitSyncActivationFailure[]> {
  const failures: AutomationGitSyncActivationFailure[] = [];
  for (const sync of options.syncs) {
    const failure = await activateAutomationGitSync(options, sync);
    if (failure !== undefined) failures.push(failure);
  }
  return failures;
}

async function activateAutomationGitSync(
  options: ActivateAutomationGitSyncsOptions,
  sync: ConfiguredAutomationGitSync,
): Promise<AutomationGitSyncActivationFailure | undefined> {
  const fail = (error: unknown): AutomationGitSyncActivationFailure => ({
    organization: sync.organization,
    connection: sync.connection,
    error,
  });
  let organizationId: string | undefined;
  try {
    organizationId = await resolveOrganizationId(options.database, sync.organization);
  } catch (error) {
    return fail(error);
  }
  if (organizationId === undefined) {
    return fail(new Error(`organization ${sync.organization} does not exist`));
  }

  const connection = await options.database.query<
    QueryRow & { id: string; installation_id: string; status: string }
  >(
    "select id, installation_id::text, status from github_connections where organization_id = $1 and slug = $2",
    [organizationId, sync.connection],
  );
  const row = connection.rows[0];
  if (row === undefined) {
    return fail(
      new Error(`the GitHub connection ${sync.connection} does not exist in this organization`),
    );
  }
  if (row.status !== "active") {
    return fail(new Error(`the GitHub connection ${sync.connection} is ${row.status}`));
  }

  const application = options.applications.github;
  if (application === undefined || application.provider !== "github") {
    return fail(new Error("the GitHub application is not configured on this instance"));
  }
  const auth = createGitHubAuth({
    appId: application.appId,
    privateKey: application.privateKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  let repository: z.infer<typeof githubRepositorySchema>;
  try {
    const token = await auth.getInstallationToken(Number(row.installation_id));
    const response = await githubRequest(options.fetch, `/repos/${sync.repository}`, token);
    if (!response.ok) {
      return fail(new Error(`GitHub answered ${String(response.status)} for ${sync.repository}`));
    }
    const parsed = githubRepositorySchema.safeParse(await response.json());
    if (!parsed.success) return fail(new Error("GitHub answered without a repository identity"));
    repository = parsed.data;
  } catch (error) {
    return fail(error);
  }

  let directory: string;
  try {
    directory = repositoryAutomationDirectory(sync.directory);
  } catch (error) {
    return fail(error);
  }

  try {
    await options.database.query(
      `insert into automation_git_sync
         (organization_id, enabled, github_connection_id, repository_id, repository_full_name,
          branch, commit_message, automations_directory, interval_minutes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (organization_id) do update set
         enabled = excluded.enabled,
         github_connection_id = excluded.github_connection_id,
         repository_id = excluded.repository_id,
         repository_full_name = excluded.repository_full_name,
         branch = excluded.branch,
         commit_message = excluded.commit_message,
         automations_directory = excluded.automations_directory,
         interval_minutes = excluded.interval_minutes`,
      [
        organizationId,
        sync.enabled ?? true,
        row.id,
        repository.id,
        repository.full_name,
        sync.branch ?? repository.default_branch,
        sync.commitMessage ?? null,
        directory,
        sync.intervalMinutes ?? 15,
      ],
    );
    return undefined;
  } catch (error) {
    return fail(error);
  }
}

function githubRequest(
  fetchOverride: typeof fetch | undefined,
  path: string,
  token: string,
): Promise<Response> {
  const request = fetchOverride ?? fetch;
  return request(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "paseo-hub",
      "x-github-api-version": "2022-11-28",
    },
  });
}
