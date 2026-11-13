import type {
  Database,
  OrganizationTriggerRecord,
  OrganizationTriggerRevisionRecord,
} from "../db/types.js";
import {
  resolveTriggerConfigurationForOrganization,
  type CompiledProjectConfiguration,
  type DaemonAgentConfigurationValidator,
} from "../configuration/store.js";
import {
  compileTriggerDocument,
  parseTriggerDocument,
  TriggerDocumentError,
  type CompiledTriggerDocument,
  type TriggerDocument,
  type TriggerDocumentIssue,
} from "./configuration/index.js";
import { isAnyDaemonTarget } from "./configuration/any-daemon.js";
import { supportsUnattendedRuns, unattendedProviderRefusal } from "./configuration/unattended.js";
import { isEnvReaction, type AgentReaction, type TriggerReaction } from "./configuration/schema.js";

export interface SaveTriggerInput {
  triggerId?: string;
  yaml: string;
  userId: string | null;
  sourceKind?: "manual" | "github";
  sourceEvidence?: unknown;
}

type AuthoredAgent = Extract<AgentReaction["agent"], { provider: string }>;

export class OrganizationTriggerStore {
  constructor(
    private readonly database: Database,
    private readonly organizationId: string,
    /**
     * The daemon's own answer about an agent. Provider, model, mode, thinking option, and options
     * are facts about the daemon that will run the trigger, not about the document, so the store
     * asks that daemon before anything is stored.
     */
    private readonly agentValidator: DaemonAgentConfigurationValidator,
  ) {}

  list(): Promise<OrganizationTriggerRecord[]> {
    return this.database.listOrganizationTriggers(this.organizationId);
  }

  async remove(triggerId: string): Promise<void> {
    await this.database.deleteOrganizationTrigger(this.organizationId, triggerId);
  }

  async activeRevision(
    trigger: OrganizationTriggerRecord,
  ): Promise<OrganizationTriggerRevisionRecord> {
    if (trigger.organizationId !== this.organizationId) {
      throw new Error("organization trigger not found");
    }
    const revision = await this.database.findOrganizationTriggerRevision(
      trigger.id,
      trigger.activeRevisionId,
    );
    if (revision === undefined) throw new Error("active trigger revision not found");
    return revision;
  }

  async save(input: SaveTriggerInput): Promise<OrganizationTriggerRecord> {
    const previousYaml = await this.activeYaml(input.triggerId);
    const prepared = await this.validate(
      input.yaml,
      previousYaml === undefined ? {} : { previousYaml },
    );
    const recurrence = prepared.compiled.authored.on["schedule.tick"]?.recurrence;
    return this.database.saveOrganizationTrigger({
      organizationId: this.organizationId,
      ...(input.triggerId === undefined ? {} : { triggerId: input.triggerId }),
      ...(recurrence === undefined ? {} : { recurrence }),
      name: prepared.compiled.authored.name,
      enabled: prepared.compiled.authored.enabled,
      format: "single_run",
      yaml: input.yaml,
      normalizedConfiguration: prepared.resolved.configuration,
      contentHash: prepared.compiled.authoredHash,
      sourceKind: input.sourceKind ?? "manual",
      sourceEvidence: input.sourceEvidence ?? {
        kind: "manual",
        authoredFormat: "self_contained_trigger_v1",
      },
      createdByUserId: input.userId,
      routes: prepared.compiled.authored.enabled ? prepared.resolved.routes : [],
    });
  }

  /**
   * Everything that has to be true before a document becomes a trigger. `previousYaml` is the
   * revision being replaced: an unchanged document skips the authoring contract (a preserved
   * legacy trigger may be re-saved as it is), and a document that keeps its target and agent
   * skips the daemon — a prompt edit does not need the daemon online, a new agent does.
   */
  async validate(yaml: string, options: { previousYaml?: string } = {}) {
    const compiled = compileTriggerDocument(yaml);
    if (options.previousYaml !== yaml) validateAuthoringContract(compiled.authored);
    const resolved = await resolveTriggerConfigurationForOrganization(
      this.database,
      this.organizationId,
      {
        environments: [compiled.environment],
        triggers: compiled.events,
      },
    );
    if (!resolved.success) {
      throw new TriggerDocumentError(resolved.issues);
    }
    if (options.previousYaml === undefined || runtimeChanged(options.previousYaml, compiled)) {
      await this.validateAgainstDaemon(compiled, resolved.configuration);
    }
    return { compiled, resolved };
  }

  private async activeYaml(triggerId: string | undefined): Promise<string | undefined> {
    if (triggerId === undefined) return undefined;
    const trigger = (await this.list()).find(({ id }) => id === triggerId);
    if (trigger === undefined) return undefined;
    return (await this.activeRevision(trigger)).yaml;
  }

  private async validateAgainstDaemon(
    compiled: CompiledTriggerDocument,
    configuration: CompiledProjectConfiguration,
  ): Promise<void> {
    const target = configuration.environments.find((environment) => environment.kind === "daemon");
    if (target === undefined) throw new Error("compiled trigger target is missing");
    const daemons = await this.validationDaemons(
      target.daemonId,
      compiled.authored.run.target.daemon,
    );
    const issues: TriggerDocumentIssue[] = [];
    for (const { path, agent } of authoredAgents(compiled.authored)) {
      if (!supportsUnattendedRuns(agent.provider)) {
        issues.push({
          path: [...path, "provider"],
          message: unattendedProviderRefusal(agent.provider),
        });
        continue;
      }
      for (const daemon of daemons) {
        issues.push(
          ...(await agentIssuesOnDaemon(
            this.agentValidator,
            daemon,
            path,
            agent,
            daemons.length > 1,
          )),
        );
      }
    }
    if (issues.length > 0) throw new TriggerDocumentError(issues);
  }

  private async validationDaemons(
    daemonId: string,
    slug: string,
  ): Promise<readonly { id: string; slug: string }[]> {
    if (!isAnyDaemonTarget(daemonId)) return [{ id: daemonId, slug }];
    const connected = (await this.database.listDaemonsForOrganization(this.organizationId)).filter(
      (daemon) =>
        daemon.status === "active" &&
        daemon.presence === "connected" &&
        daemon.permissions.includes("hub.execute"),
    );
    if (connected.length === 0) {
      throw new TriggerDocumentError([
        {
          path: ["run", "target", "daemon"],
          message:
            "No daemon is connected, so Hub cannot check this agent. Connect a daemon and save again.",
        },
      ]);
    }
    return connected.map((daemon) => ({ id: daemon.id, slug: daemon.slug }));
  }
}

/** Every agent the document may launch, each addressed by where it is written. */
function authoredAgents(
  trigger: TriggerDocument,
): readonly { path: readonly (string | number)[]; agent: AuthoredAgent }[] {
  if ("reactions" in trigger.run) return agentsIn(trigger.run.reactions, ["run", "reactions"]);
  if ("choices" in trigger.run.agent) {
    return Object.entries(trigger.run.agent.choices).map(([name, agent]) => ({
      path: ["run", "agent", "choices", name],
      agent,
    }));
  }
  return [{ path: ["run", "agent"], agent: trigger.run.agent }];
}

function agentsIn(
  reactions: readonly TriggerReaction[],
  path: readonly (string | number)[],
): { path: readonly (string | number)[]; agent: AuthoredAgent }[] {
  const found: { path: readonly (string | number)[]; agent: AuthoredAgent }[] = [];
  for (const [index, reaction] of reactions.entries()) {
    if (
      "wait" in reaction ||
      isEnvReaction(reaction) ||
      "http" in reaction ||
      "notice" in reaction
    ) {
      continue;
    }
    if ("if" in reaction) {
      found.push(...agentsIn(reaction.if.then, [...path, index, "if", "then"]));
      found.push(...agentsIn(reaction.if.else, [...path, index, "if", "else"]));
      continue;
    }
    if ("choices" in reaction.agent) {
      for (const [name, agent] of Object.entries(reaction.agent.choices)) {
        found.push({ path: [...path, index, "agent", "choices", name], agent });
      }
      continue;
    }
    found.push({ path: [...path, index, "agent"], agent: reaction.agent });
  }
  return found;
}

/** The daemon names fields by its own wire contract; the document names them by its schema. */
function authoredFieldName(segment: string | number): string | number {
  if (segment === "modeId") return "mode";
  if (segment === "providerOptions") return "options";
  return segment;
}

async function agentIssuesOnDaemon(
  validator: DaemonAgentConfigurationValidator,
  daemon: { id: string; slug: string },
  path: readonly (string | number)[],
  agent: AuthoredAgent,
  nameDaemon: boolean,
): Promise<TriggerDocumentIssue[]> {
  let verdict: Awaited<ReturnType<DaemonAgentConfigurationValidator["validateAgentConfiguration"]>>;
  try {
    verdict = await validator.validateAgentConfiguration(daemon.id, agent);
  } catch (error) {
    throw new TriggerDocumentError([
      { path: ["run", "target", "daemon"], message: daemonUnavailable(daemon.slug, error) },
    ]);
  }
  if (verdict.valid) return [];
  return verdict.issues.map((issue) => ({
    path: [...path, ...issue.path.map(authoredFieldName)],
    message: nameDaemon ? `${daemon.slug}: ${issue.message}` : issue.message,
  }));
}

function daemonUnavailable(slug: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  if (reason === "daemon_not_connected") {
    return `"${slug}" is not connected, so Hub cannot check this agent against it. Connect the daemon and save again.`;
  }
  if (reason === "daemon_execution_not_allowed") {
    return `"${slug}" cannot run Hub automations. Run \`paseo hub permissions grant hub.execute\` on it and save again.`;
  }
  return `"${slug}" could not check this agent: ${reason}`;
}

/** Whether the daemon has anything new to say: the target or an agent differs from what runs now. */
function runtimeChanged(previousYaml: string, compiled: CompiledTriggerDocument): boolean {
  let previous: TriggerDocument;
  try {
    previous = parseTriggerDocument(previousYaml);
  } catch {
    return true;
  }
  const runtime = (document: TriggerDocument) =>
    JSON.stringify({
      target: document.run.target,
      ...("reactions" in document.run
        ? { reactions: document.run.reactions }
        : { agent: document.run.agent }),
    });
  return runtime(previous) !== runtime(compiled.authored);
}

function validateAuthoringContract(trigger: TriggerDocument): void {
  const issues: Array<{ path: readonly (string | number)[]; message: string }> = [];
  if (!trigger.run.target.cwd.startsWith("/")) {
    issues.push({ path: ["run", "target", "cwd"], message: "must be an absolute path" });
  }
  for (const { path, agent } of authoredAgents(trigger)) {
    if (agent.mode === undefined) {
      issues.push({ path: [...path, "mode"], message: "is required for new triggers" });
    }
  }
  if (issues.length > 0) throw new TriggerDocumentError(issues);
}
