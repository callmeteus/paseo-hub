import { parseConnectionTemplate } from "../config/connection-template.js";
import { createHash } from "node:crypto";
import type { Database, AgentExecutionRecord } from "../db/types.js";
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  type LaunchMachineIntent,
} from "../dispatcher/launch-machine-intent.js";
import type { DaemonCreateAgentOptions } from "../daemons/protocol.js";
import type { AgentConnection, AgentEvent, AgentSnapshot } from "../daemons/agents/index.js";
import {
  executionToolDefinitions,
  type OutputExecutorRegistry,
} from "../execution-capabilities/outputs.js";
import {
  deriveAgentExecutionCompletionToken,
  hashAgentExecutionCompletionToken,
} from "../agent-executions/completion-token.js";
import type { AgentSessionRecord } from "./types.js";
export type { AgentSessionRecord, AgentSessionAction } from "./types.js";

export class AgentSessionError extends Error {}

interface DispatchInput {
  executionId: string;
  intent: LaunchMachineIntent;
  connection: AgentConnection;
  createOptions: () => Promise<DaemonCreateAgentOptions>;
  onEvent: (event: AgentEvent) => void;
}

function missingAgentSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /session/i.test(message) && /not found/i.test(message);
}

/**
 * Whether a dead session may be forgotten and retried.
 *
 * Only a named continuation can be replaced by a new agent. A session pinned to
 * one execution is that execution's agent; recreating it would duplicate the run.
 */
function canReleaseDeadSession(session: AgentSessionRecord, attempt: number): boolean {
  return attempt < 1 && session.continuationKey !== null;
}

/** An agent that ended without being archived. Resuming it only reports `agent_interrupted`. */
function isDeadAgent(agent: AgentSnapshot): boolean {
  return !agent.archivedAt && (agent.status === "closed" || agent.status === "error");
}

/**
 * The daemon no longer knows the agent this session points at.
 *
 * That is a dead continuation like any other: the next attempt has to create a new agent instead
 * of failing the arrival, otherwise every message in that conversation keeps failing.
 */
function isMissingAgentError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Continuation agent was deleted");
}

/** The daemon finished that idempotency key once and its agent is gone; the key cannot complete. */
function isCompletedCreationError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("Previously created agent no longer exists")
  );
}

/**
 * Rebuilds the agent settings of a stored session with the ones the current intent carries.
 *
 * Everything the session owns stays (MCP endpoint and token, cwd, environment, tool policy); the
 * provider, model, mode, thinking option and router follow the trigger.
 */
function withCurrentAgentSettings(
  options: DaemonCreateAgentOptions,
  agent: LaunchMachineIntent["agent"],
): DaemonCreateAgentOptions {
  const next: DaemonCreateAgentOptions = { ...options, provider: agent.provider };
  if (agent.model === undefined) delete next.model;
  else next.model = agent.model;
  if (agent.mode === undefined) delete next.mode;
  else next.mode = agent.mode;
  if (agent.thinkingOptionId === undefined) delete next.thinkingOptionId;
  else next.thinkingOptionId = agent.thinkingOptionId;
  if (agent.router === undefined) delete next.modelRouterId;
  else next.modelRouterId = agent.router;
  return next;
}

/** Owns session selection, delivery, and cleanup under the same existing database lock. */
export class AgentSessions {
  constructor(
    private readonly database: Database,
    private readonly secret: string,
    private readonly publicBaseUrl: string,
    private readonly outputs: OutputExecutorRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  async dispatch(
    input: DispatchInput,
    attempt = 0,
  ): Promise<{
    agentId: string;
    unsubscribe: () => void;
    action: "created" | "continued" | "restored";
  }> {
    if (attempt > 3) throw new AgentSessionError("session_retry_limit");
    const incoming = await this.database.findAgentExecutionById(input.executionId);
    if (!incoming || !isActive(incoming)) throw new AgentSessionError("execution_terminal");
    const policy = input.intent.continuation;
    const startupTimeoutMs = input.intent.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const continuationKey = policy?.key ?? null;
    const projectId = input.intent.projectId;
    const lockId = deriveSessionId(projectId, continuationKey ?? `execution:${input.executionId}`);
    const findSession = async () => {
      const execution = await this.database.findAgentExecutionById(input.executionId);
      if (execution?.agentSessionId)
        return this.database.findAgentSession(execution.agentSessionId);
      return continuationKey === null
        ? this.database.findAgentSession(
            deriveSessionId(projectId, `execution:${input.executionId}`),
          )
        : this.database.findAgentSessionByKey(projectId, continuationKey);
    };
    const isFinishedCredentialedSession = async (session: AgentSessionRecord) => {
      const executions = await this.database.listAgentSessionExecutions(session.id);
      return (
        executions.length > 0 &&
        !executions.some(isActive) &&
        executions.some(
          (execution) =>
            execution.launchIntent !== null && hasTemporaryCredentials(execution.launchIntent),
        )
      );
    };
    // External credential minting must not hold a database connection open during shutdown.
    const storedSession = await findSession();
    const options =
      !storedSession || (await isFinishedCredentialedSession(storedSession))
        ? await input.createOptions()
        : undefined;
    const tools = executionToolDefinitions(
      input.intent.outputSchema,
      this.outputs.materialize(input.intent.allowOutputs, input.intent.outputContext),
      hasInstructionCatalog(input.intent),
    );
    const dispatched = await this.database.withAdvisoryLock(`agent-session:${lockId}`, async () => {
      const compatibility = fingerprint({ settings: policy?.compatibility, tools });
      let session = await findSession();
      if (session && (await isFinishedCredentialedSession(session))) {
        // Completion may have raced credential preparation. Retry outside the lock.
        if (!options) return undefined;
        await this.database.saveAgentSession({ ...session, continuationKey: null });
        session = undefined;
      }
      session = await this.releaseIncompatibleSession(session, compatibility);
      session = await this.releaseStaleCredentialSession(session);
      const id = session?.id ?? deriveSessionId(projectId, `execution:${input.executionId}`);
      if (!session) {
        if (!options) {
          await this.replacePinnedSession(input, compatibility, tools);
          return undefined;
        }
        const token = deriveAgentExecutionCompletionToken(this.secret, `session:${id}`);
        session = {
          id,
          projectId: input.intent.projectId,
          organizationId: input.intent.organizationId,
          continuationKey,
          daemonId: input.intent.environment.daemonId,
          agentId: null,
          workspaceId: null,
          compatibility,
          tools,
          capabilityTokenHash: hashAgentExecutionCompletionToken(token),
          creationOptions: {
            ...options,
            // Always expose the Hub MCP to the agent session. The hub_reply /
            // hub_finish_execution tools are how workflow agents answer; without
            // them the agent answers in the Paseo chat instead of the channel
            // that triggered it. A missing continuation policy must not drop
            // this server.
            mcpServers: {
              ...options?.mcpServers,
              hub: {
                type: "http",
                url: new URL(`/agent-sessions/${id}/mcp`, this.publicBaseUrl).toString(),
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          },
        };
        await this.database.saveAgentSession(session);
      }
      const activeExecutions = (await this.database.listAgentSessionExecutions(id)).filter(
        (execution) => execution.status === "spawning" || execution.status === "running",
      );
      const deadline = activeExecutions.reduce<number>(
        (earliest, execution) =>
          Math.min(earliest, execution.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY),
        Number.POSITIVE_INFINITY,
      );
      if (Number.isFinite(deadline))
        await this.database.limitAgentExecutionDeadline(input.executionId, new Date(deadline));
      await this.database.attachExecutionToSession(input.executionId, id);
      let action: "created" | "continued" | "restored" = "continued";
      if (session.agentId === null) {
        const agent = await this.createSessionAgent(input, session, id, attempt, startupTimeoutMs);
        if (agent === undefined) return undefined;
        session = { ...session, agentId: agent.id, workspaceId: agent.workspaceId };
        await this.database.saveAgentSession(session);
        action = "created";
      }
      if (session.agentId === null || session.workspaceId === null)
        throw new Error("Session agent is missing");
      await this.database.attachAgentToExecution(
        input.executionId,
        session.daemonId,
        session.agentId,
      );
      const resolved = await this.resolveExistingAgent(session, input, startupTimeoutMs, attempt);
      if (resolved === "released") return undefined;
      if (resolved !== "continued") action = resolved;
      await this.database.attachExecutionToSession(input.executionId, id, action);
      try {
        const unsubscribe = await this.deliver(input, session.agentId, startupTimeoutMs);
        return { agentId: session.agentId, unsubscribe, action };
      } catch (error) {
        if (canReleaseDeadSession(session, attempt) && missingAgentSession(error)) {
          await this.releaseDeadContinuation(session);
          return undefined;
        }
        throw error;
      }
    });
    return dispatched ?? this.dispatch(input, attempt + 1);
  }

  /**
   * Creates the agent a session points at.
   *
   * The daemon remembers completed idempotency keys, and a key whose agent was deleted can never
   * complete again. A retry therefore creates with its own key: the session id still names the MCP
   * endpoint, and the key only deduplicates this one create.
   *
   * @returns The new agent, or undefined when the caller has to retry
   */
  private async createSessionAgent(
    input: DispatchInput,
    session: AgentSessionRecord,
    id: string,
    attempt: number,
    startupTimeoutMs: number,
  ): Promise<AgentSnapshot | undefined> {
    const createKey = attempt === 0 ? id : `${id}:${String(attempt)}`;
    try {
      // The session keeps the options of its first creation (the MCP endpoint and its token), but
      // the agent settings belong to the trigger: a model or router changed in the YAML has to
      // reach the next agent, otherwise the conversation stays on the old model forever.
      const options = withCurrentAgentSettings(session.creationOptions, input.intent.agent);
      return await input.connection.create(createKey, options, startupTimeoutMs);
    } catch (error) {
      if (attempt === 0 && isCompletedCreationError(error)) return undefined;
      throw error;
    }
  }

  /**
   * A session created for one execution uses that execution's id as its lookup
   * key. Clearing the continuation key does not hide it, so a tool change has
   * to rebuild the same row before the retry.
   */
  private async replacePinnedSession(
    input: {
      executionId: string;
      intent: LaunchMachineIntent;
    },
    compatibility: string,
    tools: AgentSessionRecord["tools"],
  ): Promise<void> {
    await this.database.clearExecutionAgentSession(input.executionId);
    const continuationKey = input.intent.continuation?.key ?? null;
    if (continuationKey !== null) return;
    const pinnedId = deriveSessionId(input.intent.projectId, `execution:${input.executionId}`);
    const pinned = await this.database.findAgentSession(pinnedId);
    if (!pinned || pinned.daemonId !== input.intent.environment.daemonId) return;
    if (pinned.compatibility === compatibility) return;
    await this.database.saveAgentSession({
      ...pinned,
      compatibility,
      tools,
      agentId: null,
      workspaceId: null,
    });
  }

  /**
   * Drops a session whose tools or target no longer match.
   *
   * Reusing it would run the arrival with the old tool set. Refusing it leaves
   * every later mention on that thread stuck, including after a provider, model,
   * tool-set, or daemon change during a migration. Release the continuation key
   * so the next arrival creates a fresh agent instead of failing closed.
   *
   * @param session - Stored session for this continuation, when one exists
   * @param compatibility - Fingerprint of the arrival
   * @returns The session to keep, or undefined when the key was released
   */
  private async releaseIncompatibleSession(
    session: AgentSessionRecord | undefined,
    compatibility: string,
  ): Promise<AgentSessionRecord | undefined> {
    if (!session || session.compatibility === compatibility) return session;
    await this.database.saveAgentSession({ ...session, continuationKey: null });
    return undefined;
  }

  /**
   * A continuation survives restarts and credential rotations. Its MCP bearer
   * is derived from the Hub auth secret, so a session created under an older
   * secret keeps a hash the current Hub cannot verify: every tool call then
   * gets a 401 and the agent answers in chat without any Hub tool. Drop that
   * continuation so the next arrival builds a fresh session and token.
   */
  private async releaseStaleCredentialSession(
    session: AgentSessionRecord | undefined,
  ): Promise<AgentSessionRecord | undefined> {
    if (!session) return session;
    const token = deriveAgentExecutionCompletionToken(this.secret, `session:${session.id}`);
    if (hashAgentExecutionCompletionToken(token) === session.capabilityTokenHash) return session;
    await this.database.saveAgentSession({ ...session, continuationKey: null });
    return undefined;
  }

  /**
   * Decides what to do with the agent attached to a reused session.
   *
   * An archived agent is restored by default so a thread can continue. A
   * continuation can opt out: its old timeline overrides a freshly compiled
   * prompt, leaving the agent stuck answering from habits formed in earlier
   * runs. In that case the continuation is released so the retry creates a
   * clean agent.
   */
  private async resolveExistingAgent(
    session: AgentSessionRecord,
    input: DispatchInput,
    startupTimeoutMs: number,
    attempt: number,
  ): Promise<"released" | "restored" | "continued"> {
    let agent: AgentSnapshot;
    try {
      agent = await input.connection.get(session.agentId!);
    } catch (error) {
      if (!isMissingAgentError(error)) throw error;
      // Nothing can resume an agent the daemon forgot, so the session is released at once and the
      // retry creates a new one. Repeating the failure only breaks every later arrival.
      await this.releaseDeadContinuation(session);
      return "released";
    }
    if (isDeadAgent(agent)) {
      if (canReleaseDeadSession(session, attempt)) {
        await this.releaseDeadContinuation(session);
        return "released";
      }
      throw new AgentSessionError("agent_interrupted");
    }
    if (
      agent.archivedAt &&
      input.intent.continuation?.restoreArchived === false &&
      canReleaseDeadSession(session, attempt)
    ) {
      await this.releaseDeadContinuation(session);
      return "released";
    }
    if (agent.archivedAt) {
      await input.connection.restore(session.workspaceId!, startupTimeoutMs);
      return "restored";
    }
    return "continued";
  }

  /**
   * Forgets a continuation whose Cursor session is already gone.
   *
   * The next attempt creates another agent. Resuming the dead one only posts
   * `agent_interrupted` into the thread.
   */
  private async releaseDeadContinuation(session: AgentSessionRecord): Promise<void> {
    await this.database.saveAgentSession({
      ...session,
      continuationKey: null,
      agentId: null,
      workspaceId: null,
    });
  }

  private async deliver(
    input: {
      executionId: string;
      intent: LaunchMachineIntent;
      connection: AgentConnection;
      onEvent: (event: AgentEvent) => void;
    },
    agentId: string,
    startupTimeoutMs: number,
  ): Promise<() => void> {
    const unsubscribe = await input.connection.watch(agentId, input.onEvent);
    try {
      const execution = await this.database.findAgentExecutionById(input.executionId);
      if (!execution || !isActive(execution)) throw new AgentSessionError("execution_terminal");
      if (execution.deadlineAt !== null && execution.deadlineAt.getTime() <= this.now()) {
        throw new AgentSessionError("execution_deadline_exceeded");
      }
      await input.connection.send(
        agentId,
        input.executionId,
        input.intent.continuation === undefined
          ? input.intent.prompt
          : `Hub execution: ${input.executionId}\nUse this executionId for Hub tool calls for this request.\n\n${input.intent.prompt}`,
        startupTimeoutMs,
      );
      return unsubscribe;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  async control(
    execution: AgentExecutionRecord,
    connection: AgentConnection,
    action: "interrupt" | "archive",
  ): Promise<boolean> {
    if (!execution.agentSessionId) return true;
    const id = execution.agentSessionId;
    const session = await this.database.findAgentSession(id);
    if (!session?.agentId || !session.workspaceId) return false;
    const { agentId, workspaceId } = session;
    return this.database.withAdvisoryLock(sessionLock(session), async () => {
      const executions = await this.database.listAgentSessionExecutions(id);
      // A completed arrival cannot stop work belonging to a newer arrival.
      if (executions.some((item) => item.status === "spawning" || item.status === "running"))
        return true;
      await connection.control(agentId, workspaceId, action);
      return true;
    });
  }

  async releaseAuthority(
    execution: AgentExecutionRecord,
    release: (executionId: string) => Promise<void>,
  ): Promise<void> {
    const sessionId = execution.agentSessionId;
    const session =
      sessionId === null ? undefined : await this.database.findAgentSession(sessionId);
    const owners =
      sessionId === null || !session
        ? [execution.id]
        : await this.database.withAdvisoryLock(sessionLock(session), async () => {
            const executions = await this.database.listAgentSessionExecutions(sessionId);
            if (executions.some((item) => item.status === "spawning" || item.status === "running"))
              return [];
            return executions.map((item) => item.id);
          });
    // Revocation can call upstream services; do not keep a database lock while it runs.
    await Promise.all(owners.map(release));
  }

  async canResumeAuthority(
    execution: AgentExecutionRecord,
    available: (executionId: string) => Promise<boolean>,
  ): Promise<boolean> {
    if (execution.agentSessionId === null) return available(execution.id);
    const owners = await this.database.listAgentSessionExecutions(execution.agentSessionId);
    for (const owner of owners) {
      if (await available(owner.id)) return true;
    }
    return false;
  }
}

function deriveSessionId(projectId: string, key: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["agent-session", projectId, key]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function hasInstructionCatalog(intent: LaunchMachineIntent): boolean {
  const instructions = intent.instructions;
  return instructions !== undefined && instructions.length > 0;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
}

function isActive(execution: AgentExecutionRecord): boolean {
  return execution.status === "spawning" || execution.status === "running";
}
function hasTemporaryCredentials(intent: LaunchMachineIntent): boolean {
  return (
    intent.github !== undefined ||
    Object.values({ ...intent.environment.env, ...intent.env }).some(
      (value) => parseConnectionTemplate(value).length > 0,
    )
  );
}
function sessionLock(session: AgentSessionRecord): string {
  return `agent-session:${session.continuationKey === null ? session.id : deriveSessionId(session.projectId, session.continuationKey)}`;
}
