import { parseExpression } from "../../workflows/expression.js";
import {
  instructionError,
  instructionsDocument,
  projectInstructions,
  textInstructions,
  type InstructionDraft,
} from "./form-drafts.js";
import { isEnvReaction, trueBranch, type TriggerReaction } from "./schema.js";

const DURATION = /^([1-9][0-9]*)(ms|s|m|h)$/u;
const IDENTIFIER = /^[a-z][a-z0-9_-]*$/u;
const PRESERVE_KEYS = [
  "env",
  "output",
  "outputs",
  "startup_timeout",
  "title",
  "auto_archive",
  "background",
] as const;

export interface AgentFields {
  agent: string;
  mode: string;
  thinkingOptionId: string;
  cursorFast: string;
  providerOptions: string;
  continuationMode: string;
  continuationKey: string;
  githubConnection: string;
  githubRepositories: string;
  githubPermissions: string;
  githubDuration: string;
  prompt: InstructionDraft[];
  maxRuntime: string;
  idleTimeout: string;
}

export namespace ReactionFlow {
  export interface Agent extends AgentFields {
    type: "agent";
    id: string;
  }

  export interface Wait {
    type: "wait";
    id: string;
    duration: string;
  }

  export interface Condition {
    type: "if";
    id: string;
    condition: string;
    then: Reaction[];
    else: Reaction[];
  }

  export type Reaction = Agent | Wait | Condition;
  export type Kind = Reaction["type"];

  export type Projection =
    | {
        status: "editable";
        flow: Reaction[];
        maxRuntime: string;
        idleTimeout: string;
        agent: AgentFields;
      }
    | { status: "yaml_only"; reason: string };

  /**
   * Reads a reaction flow into the form.
   *
   * @param reactions - Reactions from a parsed trigger document
   * @returns The form flow, or why the form cannot edit it
   */
  export function project(reactions: readonly TriggerReaction[]): Projection {
    const projected = projectList(reactions, []);
    if (projected.status !== "editable") return projected;
    const flow = projected.flow;
    const agents = listAgents(flow);
    const first = agents[0];
    if (first !== undefined) {
      const mixed = agents.some(
        (agent) => agent.maxRuntime !== first.maxRuntime || agent.idleTimeout !== first.idleTimeout,
      );
      if (mixed) {
        return {
          status: "yaml_only",
          reason: "Agent reactions use different deadlines. Edit those in YAML.",
        };
      }
    }
    return {
      status: "editable",
      flow,
      maxRuntime: first?.maxRuntime ?? "2h",
      idleTimeout: first?.idleTimeout ?? "10m",
      agent: first ?? blankAgentFields(),
    };
  }

  /**
   * Field errors for every reaction in the flow.
   *
   * @param flow - Reactions the form is editing
   * @returns Errors keyed by `flow.<id>.<field>`
   */
  export function errors(flow: readonly Reaction[]): Record<string, string> {
    const found: Record<string, string> = {};
    const ids = new Set<string>();
    const visit = (reactions: readonly Reaction[]): void => {
      for (const reaction of reactions) {
        if (ids.has(reaction.id))
          found[`flow.${reaction.id}.id`] = "Reaction names must be unique.";
        else ids.add(reaction.id);
        if (!IDENTIFIER.test(reaction.id)) {
          found[`flow.${reaction.id}.id`] =
            "Use lowercase letters, digits, and hyphens, starting with a letter.";
        }
        if (reaction.type === "wait") {
          if (!DURATION.test(reaction.duration.trim())) {
            found[`flow.${reaction.id}.duration`] = "Use a duration such as 30s, 5m, or 2h.";
          }
          continue;
        }
        if (reaction.type === "if") {
          if (reaction.condition.trim().length === 0) {
            found[`flow.${reaction.id}.condition`] = "Condition is required.";
          } else if (refused(() => parseExpression(reaction.condition)) !== undefined) {
            found[`flow.${reaction.id}.condition`] = "Condition is not a valid expression.";
          }
          if (reaction.then.length === 0 && reaction.else.length === 0) {
            found[`flow.${reaction.id}.condition`] =
              "Add a reaction to the true or the false branch.";
          }
          visit(reaction.then);
          visit(reaction.else);
          continue;
        }
        Object.assign(found, agentErrors(reaction));
      }
    };
    visit(flow);
    return found;
  }

  /**
   * Turns the current agent into the first reaction and appends another.
   *
   * @param fields - Agent fields the single-agent form already has
   * @param kind - Reaction to add after the agent
   * @returns The new flow
   */
  export function start(fields: AgentFields, kind: Kind): Reaction[] {
    const agent = agentFromFields(fields, "run");
    return [agent, blank(kind, [agent])];
  }

  /**
   * Appends a reaction to a list in the flow.
   *
   * @param flow - Current flow
   * @param kind - Reaction to add
   * @param parentId - Condition that owns the list, or undefined for the root
   * @param branch - Which side of a condition receives the reaction
   * @returns The updated flow
   */
  export function append(
    flow: readonly Reaction[],
    kind: Kind,
    parentId: string | undefined,
    branch: "root" | "then" | "else",
  ): Reaction[] {
    const created = blank(kind, flow);
    if (parentId === undefined || branch === "root") return [...flow, created];
    return mapCondition(flow, parentId, (condition) => ({
      ...condition,
      [branch]: [...condition[branch], created],
    }));
  }

  /**
   * Removes one reaction. A condition loses that reaction from whichever branch holds it.
   *
   * @param flow - Current flow
   * @param id - Reaction to remove
   * @returns The flow without that reaction
   */
  export function remove(flow: readonly Reaction[], id: string): Reaction[] {
    const next: Reaction[] = [];
    for (const reaction of flow) {
      if (reaction.id === id) continue;
      next.push(reaction.type === "if" ? removeNested(reaction, id) : reaction);
    }
    return next;
  }

  /**
   * Swaps a reaction with its neighbor in the same list.
   *
   * @param flow - Current flow
   * @param id - Reaction to move
   * @param direction - -1 moves it earlier, 1 moves it later
   * @returns The reordered flow
   */
  export function move(flow: readonly Reaction[], id: string, direction: -1 | 1): Reaction[] {
    const swapped = swap(flow, id, direction);
    if (swapped !== undefined) return swapped;
    return flow.map((reaction) =>
      reaction.type === "if"
        ? {
            ...reaction,
            ...trueBranch(move(reaction.then, id, direction)),
            else: move(reaction.else, id, direction),
          }
        : reaction,
    );
  }

  /**
   * Replaces one reaction's fields.
   *
   * @param flow - Current flow
   * @param id - Reaction to change
   * @param patch - Fields to merge
   * @returns The updated flow
   */
  export function update(
    flow: readonly Reaction[],
    id: string,
    patch: Partial<Agent> | Partial<Wait> | Partial<Condition>,
  ): Reaction[] {
    return flow.map((reaction) => {
      if (reaction.id === id) return applyPatch(reaction, patch);
      if (reaction.type !== "if") return reaction;
      return {
        ...reaction,
        ...trueBranch(update(reaction.then, id, patch)),
        else: update(reaction.else, id, patch),
      };
    });
  }

  /**
   * The first agent in the flow, in the order reactions run.
   *
   * @param flow - Reactions to search
   * @returns That agent, or undefined when the flow has none
   */
  export function firstAgent(flow: readonly Reaction[]): Agent | undefined {
    return listAgents(flow)[0];
  }

  /**
   * Whether the flow is the original single agent, so the document can stay in the old shape.
   *
   * @param flow - Reactions to test
   * @returns True when the only reaction is one agent
   */
  export function isSingleAgent(flow: readonly Reaction[]): boolean {
    const [only] = flow;
    return flow.length === 1 && only?.type === "agent";
  }

  /**
   * Writes the flow as trigger-document reactions.
   *
   * @param flow - Reactions to write
   * @param shared - Deadline shared by every agent reaction
   * @returns Plain YAML values
   */
  export function toYaml(
    flow: readonly Reaction[],
    shared: { maxRuntime: string; idleTimeout: string },
  ): unknown[] {
    return flow.map((reaction) => yamlReaction(reaction, shared));
  }
}

function projectList(
  reactions: readonly TriggerReaction[],
  allocated: readonly ReactionFlow.Reaction[],
): { status: "editable"; flow: ReactionFlow.Reaction[] } | { status: "yaml_only"; reason: string } {
  const flow: ReactionFlow.Reaction[] = [];
  for (const reaction of reactions) {
    const projected = projectReaction(reaction, [...allocated, ...flow]);
    if (projected.status !== "editable") return projected;
    flow.push(projected.reaction);
  }
  return { status: "editable", flow };
}

function placeholderCondition(id: string): ReactionFlow.Condition {
  return { type: "if", id, condition: "", ...trueBranch([]), else: [] };
}

function cursorFast(value: string | undefined): string {
  if (value === "true" || value === "false") return value;
  return "";
}

function projectReaction(
  reaction: TriggerReaction,
  existing: readonly ReactionFlow.Reaction[],
):
  | { status: "editable"; reaction: ReactionFlow.Reaction }
  | { status: "yaml_only"; reason: string } {
  if ("wait" in reaction) {
    return {
      status: "editable",
      reaction: {
        type: "wait",
        id: reaction.id ?? nextId("wait", existing),
        duration: reaction.wait.for,
      },
    };
  }
  if (isEnvReaction(reaction) || "http" in reaction || "notice" in reaction) {
    return {
      status: "yaml_only",
      reason: "Env, HTTP and notice reactions can only be edited in YAML.",
    };
  }
  if ("if" in reaction) {
    const id = reaction.id ?? nextId("check", existing);
    const reserved = [...existing, placeholderCondition(id)];
    const thenProjected = projectList(reaction.if.then, reserved);
    if (thenProjected.status !== "editable") return thenProjected;
    const elseProjected = projectList(reaction.if.else, [...reserved, ...thenProjected.flow]);
    if (elseProjected.status !== "editable") return elseProjected;
    return {
      status: "editable",
      reaction: {
        type: "if",
        id,
        condition: reaction.if.condition,
        ...trueBranch(thenProjected.flow),
        else: elseProjected.flow,
      },
    };
  }
  if ("choices" in reaction.agent) {
    return { status: "yaml_only", reason: "Agent choices can only be edited in YAML." };
  }
  const fast = reaction.agent.features?.["fast"];
  if (fast !== undefined && fast !== "true" && fast !== "false") {
    return { status: "yaml_only", reason: "The form cannot edit that Fast setting." };
  }
  return {
    status: "editable",
    reaction: {
      type: "agent",
      id: reaction.id ?? nextId(existing.length === 0 ? "run" : "agent", existing),
      ...agentFieldsFromReaction(reaction),
    },
  };
}

function agentFieldsFromReaction(
  reaction: Extract<TriggerReaction, { agent: unknown }>,
): AgentFields {
  if ("choices" in reaction.agent) return blankAgentFields();
  const agent = reaction.agent;
  return {
    agent: agent.model === undefined ? agent.provider : `${agent.provider}/${agent.model}`,
    mode: agent.mode ?? "",
    thinkingOptionId: agent.thinkingOptionId ?? "",
    cursorFast: cursorFast(agent.features?.["fast"]),
    providerOptions: agent.options === undefined ? "" : JSON.stringify(agent.options, null, 2),
    continuationMode: reaction.continuation.mode,
    continuationKey: reaction.continuation.mode === "key" ? reaction.continuation.key : "",
    githubConnection: reaction.github?.connection ?? "",
    githubRepositories: reaction.github?.repositories?.join(", ") ?? "",
    githubPermissions:
      reaction.github?.permissions === undefined
        ? ""
        : JSON.stringify(reaction.github.permissions, null, 2),
    githubDuration: reaction.github?.duration ?? "",
    prompt: projectInstructions(reaction.prompt),
    maxRuntime: reaction.max_runtime,
    idleTimeout: reaction.idle_timeout,
  };
}

function blankAgentFields(): AgentFields {
  return {
    agent: "",
    mode: "",
    thinkingOptionId: "",
    cursorFast: "",
    providerOptions: "",
    continuationMode: "conversation",
    continuationKey: "",
    githubConnection: "",
    githubRepositories: "",
    githubPermissions: "",
    githubDuration: "",
    prompt: textInstructions(""),
    maxRuntime: "2h",
    idleTimeout: "10m",
  };
}

function agentFromFields(fields: AgentFields, id: string): ReactionFlow.Agent {
  return { type: "agent", id, ...fields };
}

function blank(
  kind: ReactionFlow.Kind,
  existing: readonly ReactionFlow.Reaction[],
): ReactionFlow.Reaction {
  if (kind === "wait") return { type: "wait", id: nextId("wait", existing), duration: "5m" };
  if (kind === "if") {
    const agent = blankAgent(existing);
    return {
      type: "if",
      id: nextId("check", existing),
      condition: "${{ paseo.prompt != '' }}",
      ...trueBranch([agent]),
      else: [],
    };
  }
  return blankAgent(existing);
}

function blankAgent(existing: readonly ReactionFlow.Reaction[]): ReactionFlow.Agent {
  const previous = ReactionFlow.firstAgent(existing) ?? agentFromFields(blankAgentFields(), "run");
  return {
    ...previous,
    type: "agent",
    id: nextId("agent", existing),
    prompt: textInstructions("${{ paseo.prompt }}"),
    githubConnection: "",
    githubRepositories: "",
    githubPermissions: "",
    githubDuration: "",
    providerOptions: "",
  };
}

function nextId(prefix: string, existing: readonly ReactionFlow.Reaction[]): string {
  const used = new Set(collectIds(existing));
  if (!used.has(prefix)) return prefix;
  let suffix = 2;
  while (used.has(`${prefix}-${String(suffix)}`)) suffix += 1;
  return `${prefix}-${String(suffix)}`;
}

function collectIds(reactions: readonly ReactionFlow.Reaction[]): string[] {
  const ids: string[] = [];
  for (const reaction of reactions) {
    ids.push(reaction.id);
    if (reaction.type === "if") {
      ids.push(...collectIds(reaction.then), ...collectIds(reaction.else));
    }
  }
  return ids;
}

function listAgents(reactions: readonly ReactionFlow.Reaction[]): ReactionFlow.Agent[] {
  const agents: ReactionFlow.Agent[] = [];
  for (const reaction of reactions) {
    if (reaction.type === "agent") agents.push(reaction);
    else if (reaction.type === "if") {
      agents.push(...listAgents(reaction.then), ...listAgents(reaction.else));
    }
  }
  return agents;
}

function agentErrors(reaction: ReactionFlow.Agent): Record<string, string> {
  const found: Record<string, string> = {};
  if (reaction.agent.trim().length === 0) found[`flow.${reaction.id}.agent`] = "Agent is required.";
  if (reaction.mode.trim().length === 0)
    found[`flow.${reaction.id}.mode`] = "Execution mode is required.";
  const instructions = instructionError(reaction.prompt);
  if (instructions !== undefined) found[`flow.${reaction.id}.prompt`] = instructions;
  if (reaction.continuationMode === "key" && reaction.continuationKey.trim().length === 0) {
    found[`flow.${reaction.id}.continuationKey`] = "Enter a continuation key or expression.";
  }
  if (reaction.providerOptions.trim().length > 0) {
    const message = refused(() => JSON.parse(reaction.providerOptions));
    if (message !== undefined)
      found[`flow.${reaction.id}.providerOptions`] = "Provider options must be valid JSON.";
  }
  if (reaction.githubPermissions.trim().length > 0) {
    const message = refused(() => JSON.parse(reaction.githubPermissions));
    if (message !== undefined) {
      found[`flow.${reaction.id}.githubPermissions`] = "GitHub permissions must be valid JSON.";
    }
  }
  return found;
}

function mapCondition(
  flow: readonly ReactionFlow.Reaction[],
  parentId: string,
  change: (condition: ReactionFlow.Condition) => ReactionFlow.Condition,
): ReactionFlow.Reaction[] {
  return flow.map((reaction) => {
    if (reaction.type !== "if") return reaction;
    if (reaction.id === parentId) return change(reaction);
    return {
      ...reaction,
      ...trueBranch(mapCondition(reaction.then, parentId, change)),
      else: mapCondition(reaction.else, parentId, change),
    };
  });
}

function removeNested(condition: ReactionFlow.Condition, id: string): ReactionFlow.Condition {
  return {
    ...condition,
    ...trueBranch(ReactionFlow.remove(condition.then, id)),
    else: ReactionFlow.remove(condition.else, id),
  };
}

function swap(
  reactions: readonly ReactionFlow.Reaction[],
  id: string,
  direction: -1 | 1,
): ReactionFlow.Reaction[] | undefined {
  const index = reactions.findIndex((reaction) => reaction.id === id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= reactions.length) return undefined;
  const copy = [...reactions];
  const current = copy[index];
  const neighbor = copy[next];
  if (current === undefined || neighbor === undefined) return undefined;
  copy[index] = neighbor;
  copy[next] = current;
  return copy;
}

function yamlReaction(
  reaction: ReactionFlow.Reaction,
  shared: { maxRuntime: string; idleTimeout: string },
): unknown {
  if (reaction.type === "wait") {
    return { id: reaction.id, wait: { for: reaction.duration.trim() } };
  }
  if (reaction.type === "if") {
    const elseReactions = ReactionFlow.toYaml(reaction.else, shared);
    return {
      id: reaction.id,
      if: {
        condition: reaction.condition.trim(),
        ...trueBranch(ReactionFlow.toYaml(reaction.then, shared)),
        ...(elseReactions.length === 0 ? {} : { else: elseReactions }),
      },
    };
  }
  const identity = splitAgent(reaction.agent);
  const options = parseOptions(reaction.providerOptions);
  const github = githubAuthority(reaction);
  return {
    id: reaction.id,
    agent: {
      provider: identity.provider,
      ...(identity.model === undefined ? {} : { model: identity.model }),
      mode: reaction.mode.trim(),
      ...(reaction.thinkingOptionId.trim().length === 0
        ? {}
        : { thinkingOptionId: reaction.thinkingOptionId.trim() }),
      ...(identity.provider === "cursor" && reaction.cursorFast.trim().length > 0
        ? { features: { fast: reaction.cursorFast.trim() } }
        : {}),
      ...(options === undefined ? {} : { options }),
    },
    continuation:
      reaction.continuationMode === "key"
        ? { mode: "key", key: reaction.continuationKey.trim() }
        : { mode: reaction.continuationMode === "new" ? "new" : "conversation" },
    prompt: instructionsDocument(reaction.prompt),
    max_runtime: shared.maxRuntime.trim(),
    idle_timeout: shared.idleTimeout.trim(),
    ...(github === undefined ? {} : { github }),
  };
}

function splitAgent(value: string): { provider: string; model?: string } {
  const normalized = value.trim();
  const separator = normalized.indexOf("/");
  if (separator < 0) return { provider: normalized };
  return {
    provider: normalized.slice(0, separator).trim(),
    model: normalized.slice(separator + 1).trim(),
  };
}

function parseOptions(value: string): Record<string, unknown> | undefined {
  if (value.trim().length === 0) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Provider options must be a JSON object.");
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(parsed)) record[key] = entry;
  return record;
}

function applyPatch(
  reaction: ReactionFlow.Reaction,
  patch: Partial<ReactionFlow.Agent> | Partial<ReactionFlow.Wait> | Partial<ReactionFlow.Condition>,
): ReactionFlow.Reaction {
  if (reaction.type === "wait") {
    const duration = readPatchString(patch, "duration");
    return duration === undefined ? reaction : { ...reaction, duration };
  }
  if (reaction.type === "if") {
    const condition = readPatchString(patch, "condition");
    const then = readPatchReactions(patch, "then");
    const otherwise = readPatchReactions(patch, "else");
    return {
      ...reaction,
      ...(condition === undefined ? {} : { condition }),
      ...(then === undefined ? {} : trueBranch(then)),
      ...(otherwise === undefined ? {} : { else: otherwise }),
    };
  }
  const next = { ...reaction };
  const prompt = readInstructionPatch(patch);
  if (prompt !== undefined) next.prompt = prompt;
  for (const field of [
    "agent",
    "mode",
    "thinkingOptionId",
    "cursorFast",
    "providerOptions",
    "continuationMode",
    "continuationKey",
    "githubConnection",
    "githubRepositories",
    "githubPermissions",
    "githubDuration",
  ] as const) {
    const value = readPatchString(patch, field);
    if (value !== undefined) next[field] = value;
  }
  return next;
}

function readInstructionPatch(patch: object): InstructionDraft[] | undefined {
  const value = ownValue(patch, "prompt");
  if (!Array.isArray(value)) return undefined;
  const parts: InstructionDraft[] = [];
  for (const item of value) {
    if (!isInstructionDraft(item)) return undefined;
    parts.push(item);
  }
  return parts;
}

function isInstructionDraft(value: unknown): value is InstructionDraft {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "text") return "text" in value && typeof value.text === "string";
  if (value.kind !== "include") return false;
  return (
    "path" in value &&
    typeof value.path === "string" &&
    "root" in value &&
    typeof value.root === "string"
  );
}

function readPatchString(patch: object, key: string): string | undefined {
  const value = ownValue(patch, key);
  return typeof value === "string" ? value : undefined;
}

function readPatchReactions(patch: object, key: string): ReactionFlow.Reaction[] | undefined {
  const value = ownValue(patch, key);
  if (!Array.isArray(value)) return undefined;
  const reactions: ReactionFlow.Reaction[] = [];
  for (const item of value) {
    if (!isReaction(item)) return undefined;
    reactions.push(item);
  }
  return reactions;
}

function ownValue(patch: object, key: string): unknown {
  const bag: Record<string, unknown> = { ...patch };
  return bag[key];
}

function isReaction(value: unknown): value is ReactionFlow.Reaction {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const kind = value.type;
  return kind === "agent" || kind === "wait" || kind === "if";
}

function githubAuthority(reaction: ReactionFlow.Agent): Record<string, unknown> | undefined {
  const connection = reaction.githubConnection.trim();
  if (connection.length === 0) return undefined;
  const repositories = reaction.githubRepositories
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const permissions =
    reaction.githubPermissions.trim().length === 0
      ? undefined
      : parseOptions(reaction.githubPermissions);
  const duration = reaction.githubDuration.trim();
  return {
    connection,
    ...(repositories.length === 0 ? {} : { repositories }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(duration.length === 0 ? {} : { duration }),
  };
}

function refused(parse: () => unknown): string | undefined {
  try {
    parse();
    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "invalid";
  }
}

export function preservedReactionFields(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const kept: Record<string, unknown> = {};
  for (const key of PRESERVE_KEYS) {
    if (key in value) kept[key] = value[key];
  }
  return kept;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
