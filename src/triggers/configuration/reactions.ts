import type { AuthoredStep, CompiledAgent } from "../../config/compiler.js";
import type { Continuation } from "../continuation.js";
import {
  isEnvReaction,
  isFlowRun,
  type AgentReaction,
  type TriggerDocument,
  type TriggerReaction,
} from "./schema.js";

export interface FlattenedReactions {
  steps: AuthoredStep[];
  deadline: string;
  namedAgents: Readonly<Record<string, CompiledAgent>> | undefined;
  continuations: ReadonlyMap<string, Continuation>;
}

/**
 * Turns a reaction flow into the ordered steps the workflow engine already runs.
 *
 * A condition is not its own step. Its true branch keeps the condition, and its
 * false branch keeps the negated condition, including any condition wrapped around it.
 * A single-agent document has no flow and returns undefined.
 *
 * @param authored - Parsed trigger document
 * @returns Flattened steps, or undefined when the document is one agent
 */
export function flattenTriggerReactions(authored: TriggerDocument): FlattenedReactions | undefined {
  if (!isFlowRun(authored.run)) return undefined;
  const used = new Set<string>();
  const steps: AuthoredStep[] = [];
  const continuations = new Map<string, Continuation>();
  const namedAgents: Record<string, CompiledAgent> = {};
  let agentCount = 0;
  let deadline = "2h";

  const visit = (reactions: readonly TriggerReaction[], parent: string | undefined): void => {
    for (const reaction of reactions) {
      if ("wait" in reaction) {
        const id = allocateId(reaction.id, "wait", used);
        const condition = andExpression(parent, undefined);
        steps.push({
          id,
          wait: reaction.wait.for,
          ...(condition === undefined ? {} : { if: condition }),
        });
        continue;
      }
      if (isEnvReaction(reaction)) {
        const id = allocateId(reaction.id, "env", used);
        const condition = andExpression(parent, undefined);
        steps.push({
          id,
          env: { files: [...reaction.env.files] },
          ...(condition === undefined ? {} : { if: condition }),
        });
        continue;
      }
      if ("http" in reaction) {
        const id = allocateId(reaction.id, "http", used);
        const condition = andExpression(parent, undefined);
        steps.push({
          id,
          http: reaction.http,
          ...(condition === undefined ? {} : { if: condition }),
        });
        continue;
      }
      if ("notice" in reaction) {
        const id = allocateId(reaction.id, "notice", used);
        const condition = andExpression(parent, undefined);
        steps.push({
          id,
          notice: reaction.notice,
          ...(condition === undefined ? {} : { if: condition }),
        });
        continue;
      }
      if ("if" in reaction) {
        const positive = andExpression(parent, reaction.if.condition);
        const negative = andExpression(parent, `!(${unwrapExpression(reaction.if.condition)})`);
        visit(reaction.if.then, positive);
        visit(reaction.if.else, negative);
        continue;
      }
      const id = allocateId(reaction.id, agentCount === 0 ? "run" : "agent", used);
      agentCount += 1;
      if (agentCount === 1) deadline = reaction.max_runtime;
      rememberChoices(reaction, namedAgents);
      const condition = andExpression(parent, undefined);
      steps.push(agentStep(id, reaction, condition));
      continuations.set(id, reaction.continuation);
    }
  };

  visit(authored.run.reactions, undefined);
  if (steps.length === 0) {
    throw new Error(
      "a reaction flow needs at least one agent, wait, env, request, notice, or condition branch",
    );
  }
  return {
    steps,
    deadline,
    namedAgents: Object.keys(namedAgents).length === 0 ? undefined : namedAgents,
    continuations,
  };
}

function agentStep(
  id: string,
  reaction: AgentReaction,
  condition: string | undefined,
): AuthoredStep {
  const agent = "choices" in reaction.agent ? reaction.agent.select : reaction.agent;
  const allowOutputs = outputGrants(reaction.outputs);
  return {
    id,
    environment: "target",
    max_runtime: reaction.max_runtime,
    idle_timeout: reaction.idle_timeout,
    ...(reaction.startup_timeout === undefined
      ? {}
      : { startup_timeout: reaction.startup_timeout }),
    agent,
    ...(reaction.title === undefined ? {} : { title: reaction.title }),
    prompt: [{ text: reaction.prompt }],
    ...(reaction.env === undefined ? {} : { env: reaction.env }),
    ...(reaction.github === undefined ? {} : { github: reaction.github }),
    ...(condition === undefined ? {} : { if: condition }),
    ...(reaction.output === undefined ? {} : { output: reaction.output }),
    ...(allowOutputs === undefined ? {} : { allow_outputs: allowOutputs }),
    auto_archive: reaction.auto_archive,
    background: reaction.background,
  };
}

function outputGrants(
  outputs: AgentReaction["outputs"],
): NonNullable<Extract<AuthoredStep, { agent: unknown }>["allow_outputs"]> | undefined {
  if (outputs === undefined) return undefined;
  const grants: NonNullable<Extract<AuthoredStep, { agent: unknown }>["allow_outputs"]> = [];
  for (const [type, output] of Object.entries(outputs)) {
    grants.push({
      type,
      ...(output.max === undefined ? {} : { max: output.max }),
      ...(output.required === undefined ? {} : { required: output.required }),
    });
  }
  return grants.length === 0 ? undefined : grants;
}

function rememberChoices(
  reaction: AgentReaction,
  namedAgents: Record<string, CompiledAgent>,
): void {
  if (!("choices" in reaction.agent)) return;
  for (const [name, agent] of Object.entries(reaction.agent.choices)) {
    const current = namedAgents[name];
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(agent)) {
      throw new Error(`agent choice ${name} is defined twice`);
    }
    namedAgents[name] = agent;
  }
}

function allocateId(requested: string | undefined, fallback: string, used: Set<string>): string {
  const base = requested ?? fallback;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  let id = `${base}-${String(suffix)}`;
  while (used.has(id)) {
    suffix += 1;
    id = `${base}-${String(suffix)}`;
  }
  used.add(id);
  return id;
}

function andExpression(parent: string | undefined, own: string | undefined): string | undefined {
  if (own === undefined) return parent;
  const right = `(${unwrapExpression(own)})`;
  if (parent === undefined) return `\${{ ${right} }}`;
  return `\${{ (${unwrapExpression(parent)}) && ${right} }}`;
}

function unwrapExpression(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith("${{") && trimmed.endsWith("}}")) return trimmed.slice(3, -2).trim();
  return trimmed;
}
