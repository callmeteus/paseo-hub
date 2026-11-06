import { createHash } from "node:crypto";
import { dump, load } from "js-yaml";
import {
  compileHubConfig,
  isCompiledStaticStep,
  type AuthoredStep,
  type AuthoredTrigger,
  type CompiledAgentStep,
  type CompiledEnvironment,
  type CompiledTrigger,
} from "../../config/compiler.js";
import type { Continuation } from "../continuation.js";
import { withSlackAgentOutputs } from "../slack/agent-block.js";
import { appendSlackReactGrant } from "../slack/react.js";
import { flattenTriggerReactions, type FlattenedReactions } from "./reactions.js";
import {
  authoredPromptBlocks,
  isFlowRun,
  TriggerDocumentSchema,
  type TriggerDocument,
} from "./schema.js";

export { TriggerDocumentSchema, type TriggerDocument } from "./schema.js";
export {
  migrateLegacyBundle,
  type MigratedLegacyTrigger,
  type SelfContainedLegacyTrigger,
} from "./legacy-migration.js";

export interface TriggerDocumentIssue {
  path: readonly (string | number)[];
  message: string;
}

export class TriggerDocumentError extends Error {
  constructor(readonly issues: readonly TriggerDocumentIssue[]) {
    super(issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
    this.name = "TriggerDocumentError";
  }
}

export interface CompiledTriggerDocument {
  authored: TriggerDocument;
  environment: CompiledEnvironment;
  events: readonly CompiledTrigger[];
  authoredHash: string;
}

export function compileTriggerDocument(yaml: string): CompiledTriggerDocument {
  const authored = parseTriggerDocument(yaml);
  const flattened = flattenTriggerReactions(authored);
  const namedAgents = documentNamedAgents(authored, flattened);
  const environment = {
    name: "target",
    kind: "daemon" as const,
    ...authored.run.target,
  };
  const allowOutputs: NonNullable<
    Extract<AuthoredStep, { allow_outputs?: unknown }>["allow_outputs"]
  > = [];
  if (!isFlowRun(authored.run)) {
    for (const [type, output] of Object.entries(authored.run.outputs ?? {})) {
      const grant: NonNullable<
        Extract<AuthoredStep, { allow_outputs?: unknown }>["allow_outputs"]
      >[number] = { type };
      if (output.max !== undefined) grant.max = output.max;
      if (output.required !== undefined) grant.required = output.required;
      allowOutputs.push(grant);
    }
  }
  const triggers: AuthoredTrigger[] = [];
  const events = Object.entries(authored.on);
  // A manual dispatch addresses the trigger by its name, so `manual.run` carries it wherever it
  // is declared; otherwise the first event does.
  const named = Math.max(
    0,
    events.findIndex(([event]) => event === "manual.run"),
  );
  for (const [index, [event, definition]] of events.entries()) {
    const compiledTrigger: AuthoredTrigger = {
      name: internalEventName(authored.name, index, named),
      on: event,
      max_runtime: authored.max_runtime ?? documentDeadline(authored, flattened),
      filters: authoredFilters(event, definition),
      steps: flattened === undefined ? [legacyAgentStep(authored, allowOutputs)] : flattened.steps,
    };
    if (authored.inputs !== undefined) compiledTrigger.inputs = authored.inputs;
    triggers.push(compiledTrigger);
  }
  let compiled: ReturnType<typeof compileHubConfig>;
  try {
    compiled = compileHubConfig(
      {
        environments: [environment],
        triggers,
      },
      {
        deferUnbundledIncludes: true,
        ...(namedAgents === undefined ? {} : { namedAgents }),
      },
    );
  } catch (error) {
    throw new TriggerDocumentError([
      { path: [], message: error instanceof Error ? error.message : "trigger compilation failed" },
    ]);
  }
  const compiledEnvironment = compiled.environments[0];
  if (compiledEnvironment === undefined) {
    throw new Error("compiled trigger target is missing");
  }
  return {
    authored,
    environment: compiledEnvironment,
    events: compiled.triggers.map((trigger) =>
      withGuardrails(
        withAutomaticReply({
          ...trigger,
          steps: trigger.steps.map((step) => {
            if (isCompiledStaticStep(step)) return step;
            return { ...step, continuation: continuationFor(authored, flattened, step.id) };
          }),
        }),
        authored.run.guardrails,
      ),
    ),
    authoredHash: createHash("sha256").update(yaml).digest("hex"),
  };
}

function withGuardrails(
  trigger: CompiledTrigger,
  guardrails: CompiledTrigger["guardrails"],
): CompiledTrigger {
  if (guardrails === undefined) return trigger;
  return { ...trigger, guardrails: [...guardrails] };
}

function withAutomaticReply(trigger: CompiledTrigger): CompiledTrigger {
  const replyType = automaticReplyType(trigger.on);
  if (replyType === undefined) return trigger;
  return {
    ...trigger,
    steps: trigger.steps.map((step) => {
      if (isCompiledStaticStep(step)) return step;
      return {
        ...step,
        allowOutputs: withSlackAgentOutputs(
          automaticAllowOutputs(step.allowOutputs, replyType, trigger.on),
          step.slackAgent,
        ),
      };
    }),
  };
}

function automaticAllowOutputs(
  allowOutputs: CompiledAgentStep["allowOutputs"],
  replyType: string,
  event: string,
): CompiledAgentStep["allowOutputs"] {
  const withReply = allowOutputs.some((output) => output.type === replyType)
    ? allowOutputs
    : [...allowOutputs, { type: replyType, required: false }];
  if (event !== "slack.message" && event !== "slack.mention") return withReply;
  return appendSlackReactGrant(withReply);
}

function automaticReplyType(event: string): string | undefined {
  const provider = event.split(".", 1)[0];
  return provider === "slack" ||
    provider === "discord" ||
    provider === "linear" ||
    provider === "github"
    ? `${provider}.reply`
    : undefined;
}

function authoredFilters(
  event: string,
  definition: TriggerDocument["on"][string],
): NonNullable<AuthoredTrigger["filters"]> {
  return {
    ...definition.filters,
    ...(event === "manual.run" && definition.filters?.from_users === undefined
      ? { from_users: ["*"] }
      : {}),
    ...(definition.connection === undefined ? {} : { connection: definition.connection }),
  };
}

export function parseTriggerDocument(yaml: string): TriggerDocument {
  let input: unknown;
  try {
    input = load(yaml);
  } catch (error) {
    throw new TriggerDocumentError([
      { path: [], message: error instanceof Error ? error.message : "invalid YAML" },
    ]);
  }
  const parsed = TriggerDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new TriggerDocumentError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) =>
          typeof segment === "symbol" ? (segment.description ?? String(segment)) : segment,
        ),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

export function serializeTriggerDocument(trigger: TriggerDocument): string {
  return dump(trigger, { noRefs: true, lineWidth: -1, sortKeys: false });
}

/**
 * Named agent choices for this document, from the flow or the single run.
 *
 * @param authored - Parsed trigger document
 * @param flattened - Steps from a reaction flow, when the run has one
 * @returns Choices the compiler resolves, or undefined when the agent is inline
 */
function documentNamedAgents(authored: TriggerDocument, flattened: FlattenedReactions | undefined) {
  if (isFlowRun(authored.run)) return flattened?.namedAgents;
  if ("choices" in authored.run.agent) return authored.run.agent.choices;
  return undefined;
}

function documentDeadline(
  authored: TriggerDocument,
  flattened: FlattenedReactions | undefined,
): string {
  if (flattened !== undefined) return flattened.deadline;
  if (isFlowRun(authored.run)) return "2h";
  return authored.run.max_runtime;
}

function continuationFor(
  authored: TriggerDocument,
  flattened: FlattenedReactions | undefined,
  stepId: string,
): Continuation {
  const fromFlow = flattened?.continuations.get(stepId);
  if (fromFlow !== undefined) return fromFlow;
  if (isFlowRun(authored.run)) return { mode: "conversation" };
  return authored.run.continuation;
}

function legacyAgentStep(
  authored: TriggerDocument,
  allowOutputs: NonNullable<Extract<AuthoredStep, { allow_outputs?: unknown }>["allow_outputs"]>,
): AuthoredStep {
  if (isFlowRun(authored.run)) {
    throw new Error("a reaction flow has no single agent step");
  }
  const agent = "choices" in authored.run.agent ? authored.run.agent.select : authored.run.agent;
  return {
    id: "run",
    environment: "target",
    max_runtime: authored.run.max_runtime,
    idle_timeout: authored.run.idle_timeout,
    ...(authored.run.startup_timeout === undefined
      ? {}
      : { startup_timeout: authored.run.startup_timeout }),
    agent,
    ...(authored.run.title === undefined ? {} : { title: authored.run.title }),
    prompt: authoredPromptBlocks(authored.run.prompt),
    ...(authored.run.env === undefined ? {} : { env: authored.run.env }),
    ...(authored.run.github === undefined ? {} : { github: authored.run.github }),
    ...(authored.run.output === undefined ? {} : { output: authored.run.output }),
    ...(authored.run.slack_agent === undefined ? {} : { slack_agent: authored.run.slack_agent }),
    ...(allowOutputs.length === 0 ? {} : { allow_outputs: allowOutputs }),
    auto_archive: authored.run.auto_archive,
    background: authored.run.background,
  };
}

function internalEventName(name: string, index: number, named: number): string {
  return index === named ? name : `${name}-event-${String(index + 1)}`;
}
