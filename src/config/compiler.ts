import { eventDefinition, isEditorEvent } from "../triggers/configuration/events.js";
import { ContinuationSchema } from "../triggers/continuation.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  expressionPaths,
  parseExpression,
  expressionPathsInTemplate,
  validateExecutionTemplate,
  type Expression,
  type ExpressionPath,
} from "../workflows/expression.js";
import { compileJsonSchema, finiteSchemaChoices } from "../workflows/json-schema.js";
import {
  hashPromptPartialContent,
  validatePromptPartialPath,
  validateResolvedPromptPartialPath,
  type ResolvedPromptPartials,
} from "./prompt-partials.js";
import {
  assertInstructionRoot,
  compileRuntimePromptInclude,
  validatePromptInstructionPath,
} from "../workflows/prompt-instruction-path.js";
import {
  AuthoredGitHubAuthoritySchema,
  CompiledGitHubAuthoritySchema,
  compileGitHubAuthority,
  isGitHubAuthorityEnvironmentKey,
  validateGitHubAuthority,
  type CompiledGitHubAuthority,
} from "./github-authority.js";
import { validateConnectionTemplate } from "./connection-template.js";
import {
  migrateSlackTextFilter,
  SlackMessageRegexSchema,
  SlackMessageTextSchema,
} from "../triggers/slack/text-filter.js";
import { GuardrailsSchema, type Guardrail } from "../workflows/guardrails.js";
import { SlackAgentBlockSchema, type SlackAgentBlock } from "../triggers/slack/agent-block.js";

const IDENTIFIER = /^[a-z][a-z0-9_-]*$/u;
const EVENT_NAME = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/u;
/** `slack.reply`, or a surface output such as `slack.agent.stage`. */
const OUTPUT_TYPE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*){1,2}$/u;
const DURATION = /^([1-9][0-9]*)(ms|s|m|h)$/u;
const MAX_DURATION_MS = 24 * 60 * 60_000;
const INPUT_NAME = /^[a-z][a-z0-9_-]*$/u;
const DYNAMIC_INPUT_REFERENCE = /^\$\{\{\s*paseo\.inputs\.([a-z][a-z0-9_-]*)\s*\}\}$/u;
const EXPRESSION_START = "${{";
const EXPRESSION_END = "}}";

const InputValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

const AuthoredInputSchema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().optional(),
    default: InputValueSchema.optional(),
    choices: z.array(InputValueSchema).min(1).optional(),
  })
  .strict();

const AgentSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
    // ACP feature values. Cursor Fast is the string "false" or "true".
    features: z.record(z.string().min(1), z.string().min(1)).optional(),
    options: z.record(z.string(), z.custom<JsonValue>(isJsonValue)).optional(),
  })
  .strict();

const PromptIncludeTargetSchema = z.union([
  z.string().min(1),
  z
    .object({
      path: z.string().min(1),
      root: z.string().min(1).optional(),
    })
    .strict(),
]);
const PromptBlockSchema = z.union([
  z.object({ text: z.string() }).strict(),
  z.object({ include: PromptIncludeTargetSchema }).strict(),
]);
const JsonSchemaSchema = z.record(z.string(), z.unknown());

const AllowOutputSchema = z
  .object({
    type: z.string().regex(EVENT_NAME),
    max: z.number().int().nonnegative().optional(),
    required: z.boolean().optional(),
  })
  .strict()
  .superRefine((output, context) => {
    if (output.max === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max"],
        message:
          output.required === true
            ? "required outputs must have max at least 1"
            : "output max must be greater than 0",
      });
    }
  });

const AuthoredTriggerFilterSchema = z
  .object({
    pattern: z.string().optional(),
    contains: z.string().optional(),
    /**
     * Legacy Slack terms that must all appear. Slack compiles each term into `regex`
     * and matches that list instead. GitHub does not read this field.
     */
    contains_all: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Legacy Slack terms of which one must appear. Slack compiles them into one
     * alternation inside `regex`. GitHub does not read this field.
     */
    contains_any: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Literal text and regular expressions that must all match the raw Slack message.
     * A string is case-insensitive literal text with a letter or number boundary.
     * `{ regex }` is a regular expression. Omit the field for no literal filter.
     * When `regex` is also set, every clause from both lists has to match.
     * GitHub does not read this field.
     */
    text: SlackMessageTextSchema.optional(),
    /**
     * Expressions that must all match the raw Slack message. Each string is a regular expression.
     * Omit the field for no expression filter. The author writes anchors when the match must be a prefix.
     * GitHub does not read this field.
     */
    regex: SlackMessageRegexSchema.optional(),
    /** GitHub text which makes an event ineligible, such as a command another trigger owns. */
    exclude_contains: z.string().optional(),
    label: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).min(1).optional(),
    repo: z.string().min(1).optional(),
    guild: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    /** A Linear project UUID. It is deliberately a string so imported Linear IDs work verbatim. */
    project: z.string().min(1).optional(),
    /** Linear workflow-state IDs which are eligible for this trigger. */
    states: z.array(z.string().min(1)).min(1).optional(),
    /** Linear label IDs which make an issue ineligible. */
    exclude_labels: z.array(z.string().min(1)).min(1).optional(),
    /** Linear user IDs which may be assigned to the issue. */
    assignees: z.array(z.string().min(1)).min(1).optional(),
    channels: z.array(z.string().min(1)).optional(),
    from_users: z.array(z.string().min(1)).optional(),
    /** When true, a Slack message from another app can run this trigger. Off when omitted. */
    include_bots: z.boolean().optional(),
    webhook_secret: z.string().min(32).optional(),
    inputs: z.record(z.string(), InputValueSchema).optional(),
    connection: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .optional(),
  })
  .strict();

const CompiledTriggerFilterSchema = AuthoredTriggerFilterSchema.extend({
  connectionId: z.string().uuid().optional(),
  resourceId: z.string().min(1).optional(),
}).superRefine((filter, context) => {
  if (filter.resourceId !== undefined && filter.connectionId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["resourceId"],
      message: "resourceId requires connectionId",
    });
  }
});

export const WorktreeTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("branch-off"),
    newBranch: z.string().min(1),
    base: z.string().min(1).optional(),
  }),
  z.object({ mode: z.literal("checkout-branch"), branch: z.string().min(1) }),
  z.object({ mode: z.literal("checkout-pr"), prNumber: z.number().int().positive() }),
]);

const EnvironmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      name: z.string().min(1),
      kind: z.literal("daemon"),
      daemon: z.string().min(1),
      cwd: z.string().min(1),
      worktree: WorktreeTargetSchema.optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1),
      kind: z.literal("fly"),
      image: z.string().min(1),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1),
      kind: z.literal("docker"),
      image: z.string().min(1),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
]);

const AuthoredAgentSelectionSchema = z.union([AgentSchema, z.string().min(1)]);

const AgentStepSchema = z
  .object({
    id: z.string().min(1),
    environment: z.string().min(1),
    max_runtime: z.string().min(1),
    idle_timeout: z.string().min(1),
    startup_timeout: z.string().min(1).optional(),
    agent: AuthoredAgentSelectionSchema,
    title: z.string().min(1).optional(),
    prompt: z.array(PromptBlockSchema).min(1),
    env: z.record(z.string().min(1), z.string()).optional(),
    github: AuthoredGitHubAuthoritySchema.optional(),
    if: z.string().min(1).optional(),
    output: z.object({ schema: JsonSchemaSchema }).strict().optional(),
    allow_outputs: z.array(AllowOutputSchema).optional(),
    slack_agent: SlackAgentBlockSchema.optional(),
    auto_archive: z.boolean().optional(),
    background: z.boolean().optional(),
  })
  .strict();

const WaitStepSchema = z
  .object({
    id: z.string().min(1),
    wait: z.string().min(1),
    if: z.string().min(1).optional(),
  })
  .strict();

const EnvStepSchema = z
  .object({
    id: z.string().min(1),
    env: z
      .object({
        files: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    if: z.string().min(1).optional(),
  })
  .strict();

const HttpStepSchema = z
  .object({
    id: z.string().min(1),
    http: z
      .object({
        method: z.enum(["GET", "POST"]),
        url: z.string().startsWith("https://"),
        number_from_prompt: z.literal(true),
        path: z.enum(["assign"]).optional(),
        headers: z.record(z.string().min(1), z.string().min(1)),
      })
      .strict(),
    if: z.string().min(1).optional(),
  })
  .strict();

const NoticeStepSchema = z
  .object({
    id: z.string().min(1),
    notice: z
      .object({
        text: z.string().min(1),
      })
      .strict(),
    if: z.string().min(1).optional(),
  })
  .strict();

const StepSchema = z.union([
  WaitStepSchema,
  EnvStepSchema,
  HttpStepSchema,
  NoticeStepSchema,
  AgentStepSchema,
]);

const AuthoredTriggerSchema = z
  .object({
    name: z.string().min(1),
    on: z.string().min(1),
    max_runtime: z.string().min(1),
    steps: z.array(StepSchema).min(1),
    inputs: z.record(z.string(), AuthoredInputSchema).optional(),
    values: z.record(z.string(), z.string().min(1)).optional(),
    filters: AuthoredTriggerFilterSchema.optional(),
  })
  .strict();

const AuthoredSchema = z
  .object({
    environments: z.array(EnvironmentSchema).min(1),
    triggers: z.array(AuthoredTriggerSchema),
  })
  .strict();

export const HubConfigSchema = AuthoredSchema;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type AuthoredEnvironment = z.infer<typeof EnvironmentSchema>;
export type AuthoredStep = z.infer<typeof StepSchema>;
export type AuthoredTrigger = z.infer<typeof AuthoredTriggerSchema>;
export type AuthoredTriggerFilter = z.infer<typeof AuthoredTriggerFilterSchema>;
export type AuthoredHubConfig = z.infer<typeof AuthoredSchema>;

export type AuthoredInput = z.infer<typeof AuthoredInputSchema>;

export type CompiledPromptBlock =
  | { kind: "text"; value: string }
  | { kind: "partial"; path: string; content: string; contentHash: string }
  | { kind: "include"; path: string; root?: string | undefined };

/**
 * Text already stored on a compiled prompt block.
 *
 * An include has no text until the run reads the file, so migration cannot inline it.
 *
 * @param block - One compiled prompt block
 * @returns The stored text
 */
export function staticPromptText(block: CompiledPromptBlock): string {
  if (block.kind === "text") return block.value;
  if (block.kind === "partial") return block.content;
  throw new Error(`prompt include ${block.path} is read when the run starts`);
}

export interface CompiledAgent {
  provider: string;
  model?: string | undefined;
  mode?: string | undefined;
  thinkingOptionId?: string | undefined;
  features?: Readonly<Record<string, string>> | undefined;
  options?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface CompiledNamedAgentSelection {
  selector: string;
  choices: Readonly<Record<string, CompiledAgent>>;
}

export type CompiledAgentSelection = CompiledAgent | CompiledNamedAgentSelection;

export interface CompiledInput {
  type: AuthoredInput["type"];
  required: boolean;
  default?: JsonPrimitive | undefined;
  choices?: readonly JsonPrimitive[] | undefined;
}

export interface CompiledStep {
  continuation?: import("../triggers/continuation.js").Continuation | undefined;
  id: string;
  environment: string;
  maxRuntimeMs: number;
  idleTimeoutMs: number;
  startupTimeoutMs?: number | undefined;
  agent: CompiledAgentSelection;
  /** Execution template for the workspace title; absent means Hub's default workspace title. */
  title?: string | undefined;
  prompt: readonly CompiledPromptBlock[];
  env?: Readonly<Record<string, string>> | undefined;
  github?: CompiledGitHubAuthority | undefined;
  condition?: Expression | undefined;
  output?: { schema: JsonValue } | undefined;
  allowOutputs: readonly { type: string; max?: number | undefined; required: boolean }[];
  /** Present when this step opted into the Slack agent surface. */
  slackAgent?: SlackAgentBlock | undefined;
  autoArchive: boolean;
  background: boolean;
  /** Set when this step pauses the run instead of launching its agent. */
  waitMs?: number | undefined;
  /** Dotenv files named by the workflow. The values stay out of the step output. */
  envFiles?: readonly string[] | undefined;
  /** Set when Hub calls the deploy API itself and stores the JSON. */
  http?:
    | {
        method: "GET" | "POST";
        url: string;
        numberFromPrompt: true;
        path?: "assign" | undefined;
        /** Header templates. `${var:KEY}` resolves from earlier env files at request time. */
        headers: Readonly<Record<string, string>>;
      }
    | undefined;
  /** Set when Hub posts the text itself. */
  notice?: { text: string } | undefined;
}

/** An agent step. A wait uses the same shape and sets `waitMs`. */
export type CompiledAgentStep = CompiledStep;

/**
 * Whether this compiled step pauses the run instead of launching an agent.
 *
 * @param step - Step from a compiled trigger
 * @returns True when the step is a wait
 */
export function isCompiledWaitStep(step: CompiledStep): boolean {
  return step.waitMs !== undefined;
}

/**
 * Whether Hub runs this step itself instead of launching an agent.
 *
 * @param step - Step from a compiled trigger
 * @returns True for a wait, an env load, an HTTP call, or a notice
 */
export function isCompiledStaticStep(step: CompiledStep): boolean {
  return (
    step.waitMs !== undefined ||
    step.envFiles !== undefined ||
    step.http !== undefined ||
    step.notice !== undefined
  );
}

export type CompiledSteps = readonly CompiledStep[];

export type CompiledTriggerFilter = Readonly<
  Omit<
    AuthoredTriggerFilter,
    "channels" | "from_users" | "states" | "labels" | "exclude_labels" | "assignees"
  > & {
    channels?: readonly string[] | undefined;
    from_users?: readonly string[] | undefined;
    states?: readonly string[] | undefined;
    labels?: readonly string[] | undefined;
    exclude_labels?: readonly string[] | undefined;
    assignees?: readonly string[] | undefined;
    inputs?: Readonly<Record<string, JsonPrimitive>> | undefined;
    connectionId?: string | undefined;
    resourceId?: string | undefined;
  }
>;

export type CompiledEnvironment =
  | (Extract<AuthoredEnvironment, { kind: "daemon" }> & { daemonId?: string | undefined })
  | Exclude<AuthoredEnvironment, { kind: "daemon" }>;

export interface CompiledTrigger {
  name: string;
  sourceFile?: string | undefined;
  on: string;
  maxRuntimeMs: number;
  steps: CompiledSteps;
  inputs: Readonly<Record<string, CompiledInput>>;
  values: Readonly<Record<string, Expression>>;
  filters?: CompiledTriggerFilter | undefined;
  /** Rails enforced when this run sends a message. Absent means no extra restriction. */
  guardrails?: readonly Guardrail[] | undefined;
}

export interface CompiledHubConfig {
  environments: readonly CompiledEnvironment[];
  triggers: readonly CompiledTrigger[];
}

export interface CompileHubConfigOptions {
  resolvedPromptPartials?: ResolvedPromptPartials;
  namedAgents?: Readonly<Record<string, CompiledAgent>>;
  sourceFiles?: Readonly<Record<string, string>>;
  /**
   * Automation documents name instruction files that are read when the run
   * starts. Workflow bundles still resolve `include` from the partial bundle.
   */
  deferUnbundledIncludes?: boolean;
}

/** A compiler failure located in the conceptual authored configuration tree. */
export class HubConfigurationCompilationError extends Error {
  constructor(
    readonly path: readonly (string | number)[],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HubConfigurationCompilationError";
  }
}

const CompiledPromptBlockSchema: z.ZodType<CompiledPromptBlock> = z.union([
  z.object({ kind: z.literal("text"), value: z.string() }).strict(),
  z
    .object({
      kind: z.literal("partial"),
      path: z.string().min(1),
      content: z.string(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal("include"),
      path: z.string().min(1),
      root: z.string().min(1).optional(),
    })
    .strict(),
]);

const CompiledAgentSchema: z.ZodType<CompiledAgent> = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
    features: z.record(z.string().min(1), z.string().min(1)).optional(),
    options: z.record(z.string(), z.custom<JsonValue>(isJsonValue)).optional(),
  })
  .strict();

const CompiledAgentSelectionSchema: z.ZodType<CompiledAgentSelection> = z.union([
  CompiledAgentSchema,
  z
    .object({
      selector: z.string().min(1),
      choices: z.record(z.string(), CompiledAgentSchema),
    })
    .strict(),
]);

const CompiledInputSchema: z.ZodType<CompiledInput> = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean(),
    default: InputValueSchema.optional(),
    choices: z.array(InputValueSchema).min(1).optional(),
  })
  .strict();

const CompiledEnvironmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      name: z.string().regex(IDENTIFIER),
      kind: z.literal("daemon"),
      daemon: z.string().min(1),
      daemonId: z.string().min(1).optional(),
      cwd: z.string().min(1),
      worktree: WorktreeTargetSchema.optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().regex(IDENTIFIER),
      kind: z.literal("fly"),
      image: z.string().min(1),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().regex(IDENTIFIER),
      kind: z.literal("docker"),
      image: z.string().min(1),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
]);

const CompiledJsonSchemaSchema = z.custom<JsonValue>(
  (value) => isJsonValue(value) && isRecord(value),
);

const CompiledStepSchema: z.ZodType<CompiledStep> = z
  .object({
    continuation: ContinuationSchema.optional(),
    id: z.string().regex(IDENTIFIER),
    environment: z.string().min(1),
    maxRuntimeMs: z.number().int().positive().max(MAX_DURATION_MS),
    idleTimeoutMs: z.number().int().positive().max(MAX_DURATION_MS),
    startupTimeoutMs: z.number().int().positive().max(MAX_DURATION_MS).optional(),
    agent: CompiledAgentSelectionSchema,
    title: z.string().min(1).optional(),
    prompt: z.array(CompiledPromptBlockSchema).min(1),
    env: z.record(z.string(), z.string()).optional(),
    github: CompiledGitHubAuthoritySchema.optional(),
    condition: z.custom<Expression>(isExpression).optional(),
    output: z.object({ schema: CompiledJsonSchemaSchema }).strict().optional(),
    allowOutputs: z.array(
      z
        .object({
          type: z.string().regex(OUTPUT_TYPE),
          max: z.number().int().positive().optional(),
          required: z.boolean().default(false),
        })
        .strict(),
    ),
    slackAgent: SlackAgentBlockSchema.optional(),
    autoArchive: z.boolean(),
    background: z.boolean().default(false),
    waitMs: z.number().int().positive().max(MAX_DURATION_MS).optional(),
    envFiles: z.array(z.string().min(1)).min(1).optional(),
    http: z
      .object({
        method: z.enum(["GET", "POST"]),
        url: z.string().min(1),
        numberFromPrompt: z.literal(true),
        path: z.enum(["assign"]).optional(),
        headers: z.record(z.string().min(1), z.string().min(1)),
      })
      .strict()
      .optional(),
    notice: z
      .object({
        text: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const CompiledTriggerSchema: z.ZodType<CompiledTrigger> = z
  .object({
    name: z.string().regex(IDENTIFIER),
    sourceFile: z.string().min(1).optional(),
    on: z.string().regex(EVENT_NAME),
    maxRuntimeMs: z.number().int().positive().max(MAX_DURATION_MS),
    steps: z.array(CompiledStepSchema),
    inputs: z.record(z.string(), CompiledInputSchema),
    values: z.record(z.string(), z.custom<Expression>(isExpression)),
    filters: CompiledTriggerFilterSchema.optional(),
    guardrails: GuardrailsSchema.optional(),
  })
  .strict();

const CompiledHubConfigSchema: z.ZodType<CompiledHubConfig> = z
  .object({
    environments: z.array(CompiledEnvironmentSchema).min(1),
    triggers: z.array(CompiledTriggerSchema),
  })
  .strict();

export function compileHubConfig(
  raw: unknown,
  options: CompileHubConfigOptions = {},
): CompiledHubConfig {
  rejectRemovedFields(raw);
  const authored = AuthoredSchema.parse(raw);
  validateAuthoredIds(authored);
  const environmentNames = new Set(authored.environments.map((environment) => environment.name));
  const environments = new Map(
    authored.environments.map((environment) => [environment.name, environment]),
  );
  validateEnvironmentTemplates(authored.environments);
  const triggers = authored.triggers.map((trigger) =>
    compileTrigger(
      trigger,
      environmentNames,
      environments,
      options.resolvedPromptPartials,
      options.namedAgents ?? {},
      options.sourceFiles?.[trigger.name],
      options.deferUnbundledIncludes === true,
    ),
  );
  const compiled = { environments: authored.environments, triggers } satisfies CompiledHubConfig;
  validateCompiledContract(compiled);
  return deepFreeze(compiled);
}

export function parseCompiledHubConfig(value: unknown): CompiledHubConfig {
  let cloned: unknown;
  try {
    cloned = structuredClone(value);
  } catch {
    throw new Error("active configuration contains an invalid compiled workflow contract");
  }
  const parsed = CompiledHubConfigSchema.safeParse(cloned);
  if (!parsed.success) {
    throw new Error("active configuration contains an invalid compiled workflow contract");
  }
  try {
    validateCompiledContract(parsed.data);
  } catch {
    throw new Error("active configuration contains an invalid compiled workflow contract");
  }
  // A configuration saved before `regex` still has the old Slack text fields. Migrate on load
  // so matching does not skip those triggers. Install stores the compiled list after this.
  return deepFreeze({
    ...parsed.data,
    triggers: parsed.data.triggers.map((trigger) => migrateSlackTextFilter(trigger)),
  });
}

export function compiledConfigurationHash(configuration: CompiledHubConfig): string {
  return hashConfiguration(parseCompiledHubConfig(configuration));
}

export function rawConfigurationHash(configuration: unknown): string {
  return hashConfiguration(configuration);
}

export function parseDurationMs(value: string, field: string): number {
  const match = DURATION.exec(value);
  if (match === null) {
    throw new Error(`${field} must be a positive duration such as 30s or 2h`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  let multiplier: number;
  if (unit === "ms") multiplier = 1;
  else if (unit === "s") multiplier = 1_000;
  else if (unit === "m") multiplier = 60_000;
  else multiplier = 3_600_000;
  const duration = amount * multiplier;
  if (!Number.isSafeInteger(duration) || duration > MAX_DURATION_MS) {
    throw new Error(`${field} must not exceed 24h`);
  }
  return duration;
}

function compileTrigger(
  trigger: AuthoredTrigger,
  environmentNames: ReadonlySet<string>,
  environments: ReadonlyMap<string, AuthoredEnvironment>,
  resolvedPromptPartials: ResolvedPromptPartials | undefined,
  namedAgents: Readonly<Record<string, CompiledAgent>>,
  sourceFile: string | undefined,
  deferUnbundledIncludes: boolean,
): CompiledTrigger {
  const triggerPath = ["triggers", trigger.name] as const;
  compileAt([...triggerPath, "on"], () => {
    if (!EVENT_NAME.test(trigger.on)) throw new Error(`invalid trigger event: ${trigger.on}`);
  });
  const inputs = compileAt([...triggerPath, "inputs"], () => compileInputs(trigger));
  compileAt([...triggerPath, "filters"], () => validateInputFilters(trigger, inputs));
  compileAt([...triggerPath, "steps"], () =>
    validateEnvironmentInputChoices(trigger, inputs, environmentNames, environments),
  );
  const steps = trigger.steps.map((step) =>
    compileStep(
      trigger,
      step,
      environmentNames,
      environments,
      resolvedPromptPartials,
      namedAgents,
      deferUnbundledIncludes,
    ),
  );
  const values = compileValues(trigger);
  const compiled = {
    name: trigger.name,
    ...(sourceFile === undefined ? {} : { sourceFile }),
    on: trigger.on,
    maxRuntimeMs: compileAt([...triggerPath, "max_runtime"], () =>
      parseDurationMs(trigger.max_runtime, `trigger ${trigger.name} max_runtime`),
    ),
    steps,
    inputs,
    values,
    ...(trigger.filters === undefined
      ? {}
      : { filters: migrateSlackTextFilter({ on: trigger.on, filters: trigger.filters }).filters }),
  };
  validateExpressionContract(trigger.name, compiled, environments);
  return compiled;
}

/** An env reaction lists files. An agent step may also have `env`, and those values are strings. */
function isAuthoredEnvStep(
  step: AuthoredStep,
): step is Extract<AuthoredStep, { env: { files: readonly string[] } }> {
  return "env" in step && typeof step.env === "object" && step.env !== null && "files" in step.env;
}

function compilePassiveStep(
  trigger: AuthoredTrigger,
  step: Extract<
    AuthoredStep,
    { wait: unknown } | { env: unknown } | { http: unknown } | { notice: unknown }
  >,
  stepPath: readonly (string | number)[],
  environmentNames: ReadonlySet<string>,
): CompiledStep {
  const authoredCondition = step.if;
  const condition =
    authoredCondition === undefined
      ? undefined
      : compileAt([...stepPath, "if"], () => parseExpression(authoredCondition));
  const environment = [...environmentNames][0];
  if (environment === undefined) {
    throw new Error(`step ${step.id} requires a daemon environment`);
  }
  const shell = {
    id: step.id,
    environment,
    agent: { provider: "codex" },
    allowOutputs: [],
    autoArchive: false,
    background: false,
    ...(condition === undefined ? {} : { condition }),
  };
  if ("wait" in step) {
    const waitMs = compileAt([...stepPath, "wait"], () =>
      parseDurationMs(step.wait, `trigger ${trigger.name} step ${step.id} wait`),
    );
    // The agent fields stay present so a wait is still a workflow step. The engine
    // sees waitMs and does not launch them.
    return {
      ...shell,
      waitMs,
      maxRuntimeMs: waitMs,
      idleTimeoutMs: waitMs,
      prompt: [{ kind: "text", value: "wait" }],
    };
  }
  // env, http and notice are the same kind of step: Hub runs them and does not launch the agent.
  const passive = {
    ...shell,
    maxRuntimeMs: 60_000,
    idleTimeoutMs: 60_000,
    prompt: [{ kind: "text" as const, value: "static" }],
  };
  if (isAuthoredEnvStep(step)) return { ...passive, envFiles: step.env.files };
  if ("http" in step) {
    return {
      ...passive,
      http: {
        method: step.http.method,
        url: step.http.url,
        numberFromPrompt: true as const,
        ...(step.http.path === undefined ? {} : { path: step.http.path }),
        headers: step.http.headers,
      },
    };
  }
  return { ...passive, notice: { text: step.notice.text } };
}

function validateStepOutputReference(
  trigger: CompiledTrigger,
  stepOrdinals: ReadonlyMap<string, number>,
  reference: ExpressionPath,
  ordinal: number,
  path: string,
  authorityBearing: boolean,
): void {
  if (reference.namespace !== "steps") return;
  const referencedOrdinal = stepOrdinals.get(reference.stepId);
  if (referencedOrdinal === undefined)
    throw new Error(`${path} references unknown step ${reference.stepId}`);
  if (referencedOrdinal >= ordinal) {
    throw new Error(`${path} cannot reference forward step ${reference.stepId}`);
  }
  const referencedStep = trigger.steps[referencedOrdinal];
  if (referencedStep?.http !== undefined || referencedStep?.notice !== undefined) {
    if (authorityBearing) {
      throw new Error(`${path} uses a static step output in an authority-bearing field`);
    }
    return;
  }
  if (
    referencedStep === undefined ||
    !("output" in referencedStep) ||
    referencedStep.output === undefined
  ) {
    throw new Error(
      `${path} references output from step ${reference.stepId} without an output schema`,
    );
  }
  if (authorityBearing && !hasFiniteSchemaChoices(referencedStep.output.schema, reference.path)) {
    throw new Error(
      `${path} uses agent output without provable finite choices for authority; use a finite enum or const`,
    );
  }
}

function compileStep(
  trigger: AuthoredTrigger,
  step: AuthoredStep,
  environmentNames: ReadonlySet<string>,
  environments: ReadonlyMap<string, AuthoredEnvironment>,
  resolvedPromptPartials: ResolvedPromptPartials | undefined,
  namedAgents: Readonly<Record<string, CompiledAgent>>,
  deferUnbundledIncludes: boolean,
): CompiledStep {
  const stepPath = ["triggers", trigger.name, "steps", step.id] as const;
  if ("wait" in step || isAuthoredEnvStep(step) || "http" in step || "notice" in step) {
    return compilePassiveStep(trigger, step, stepPath, environmentNames);
  }
  compileAt([...stepPath, "environment"], () => {
    if (!environmentNames.has(step.environment) && !step.environment.includes(EXPRESSION_START)) {
      throw new Error(`step ${step.id} references unknown environment ${step.environment}`);
    }
    const staticEnvironment = environments.get(step.environment);
    if (staticEnvironment !== undefined && staticEnvironment.kind !== "daemon") {
      throw new Error(
        `trigger ${trigger.name} step ${step.id} environment ${step.environment} must be a daemon environment`,
      );
    }
  });
  const maxRuntimeMs = compileAt([...stepPath, "max_runtime"], () =>
    parseDurationMs(step.max_runtime, `trigger ${trigger.name} step ${step.id} max_runtime`),
  );
  const idleTimeoutMs = compileAt([...stepPath, "idle_timeout"], () =>
    parseDurationMs(step.idle_timeout, `trigger ${trigger.name} step ${step.id} idle_timeout`),
  );
  if (idleTimeoutMs > maxRuntimeMs) {
    throw new Error(`step ${step.id} idle_timeout must not exceed max_runtime`);
  }
  const authoredCondition = step.if;
  const condition =
    authoredCondition === undefined
      ? undefined
      : compileAt([...stepPath, "if"], () => parseExpression(authoredCondition));
  const outputDeclaration =
    step.output === undefined ? undefined : { schema: cloneJsonValue(step.output.schema) };
  if (outputDeclaration !== undefined)
    validateOutputSchema(outputDeclaration.schema, `step ${step.id} output.schema`);
  const env = step.env === undefined ? undefined : { ...step.env };
  const github =
    step.github === undefined
      ? undefined
      : compileGitHubAuthority(step.github, `trigger ${trigger.name} step ${step.id} github`);
  validateStepEnvironmentContract(trigger.name, trigger.on, step.id, env, github);
  const agent = compileAt([...stepPath, "agent"], () =>
    compileAgentSelection(trigger.name, step.id, step.agent, namedAgents),
  );
  return {
    id: step.id,
    environment: step.environment,
    maxRuntimeMs,
    idleTimeoutMs,
    ...(step.startup_timeout === undefined
      ? {}
      : {
          startupTimeoutMs: compileAt([...stepPath, "startup_timeout"], () =>
            parseDurationMs(
              step.startup_timeout!,
              `trigger ${trigger.name} step ${step.id} startup_timeout`,
            ),
          ),
        }),
    agent,
    ...(step.title === undefined ? {} : { title: step.title }),
    prompt: compilePromptBlocks(
      trigger.name,
      step.id,
      step.prompt,
      resolvedPromptPartials,
      deferUnbundledIncludes,
    ),
    ...(env === undefined ? {} : { env }),
    ...(github === undefined ? {} : { github }),
    ...(condition === undefined ? {} : { condition }),
    ...(outputDeclaration === undefined ? {} : { output: outputDeclaration }),
    ...authoredSlackAgent(step),
    allowOutputs: (step.allow_outputs ?? []).map((allowOutput) => ({
      type: allowOutput.type,
      max: allowOutput.max ?? 1,
      required: allowOutput.required ?? false,
    })),
    autoArchive: step.auto_archive ?? false,
    background: step.background ?? false,
  };
}

function authoredSlackAgent(
  step: AuthoredStep,
): { slackAgent: SlackAgentBlock } | Record<string, never> {
  if (!("slack_agent" in step) || step.slack_agent === undefined) return {};
  return { slackAgent: step.slack_agent };
}

function compileAgentSelection(
  triggerName: string,
  stepId: string,
  authored: Extract<AuthoredStep, { agent: unknown }>["agent"],
  namedAgents: Readonly<Record<string, CompiledAgent>>,
): CompiledAgentSelection {
  if (typeof authored === "string") {
    if (!authored.includes(EXPRESSION_START)) {
      const selected = namedAgents[authored];
      if (selected === undefined) {
        throw new Error(
          `trigger ${triggerName} step ${stepId} references unknown named agent ${authored}`,
        );
      }
      return cloneAgent(selected);
    }
    return {
      selector: authored,
      choices: Object.fromEntries(
        Object.entries(namedAgents)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, agent]) => [name, cloneAgent(agent)]),
      ),
    };
  }
  for (const value of [
    authored.provider,
    authored.model,
    authored.mode,
    authored.thinkingOptionId,
  ]) {
    if (value?.includes(EXPRESSION_START) === true) {
      throw new Error(
        `trigger ${triggerName} step ${stepId}: dynamic inline agent configurations are not allowed; select a complete named agent instead`,
      );
    }
  }
  return cloneAgent(authored);
}

function cloneAgent(agent: CompiledAgent): CompiledAgent {
  return {
    ...agent,
    ...(agent.features === undefined ? {} : { features: { ...agent.features } }),
    ...(agent.options === undefined ? {} : { options: cloneJsonObject(agent.options) }),
  };
}

function compilePromptBlocks(
  triggerName: string,
  stepId: string,
  blocks: Extract<AuthoredStep, { prompt: unknown }>["prompt"],
  resolvedPromptPartials: ResolvedPromptPartials | undefined,
  deferUnbundledIncludes: boolean,
): readonly CompiledPromptBlock[] {
  return blocks.map((block, index) => {
    if ("text" in block) return { kind: "text" as const, value: block.text };
    if (deferUnbundledIncludes) {
      try {
        return compileRuntimePromptInclude(block.include);
      } catch (error) {
        throw new Error(
          `trigger ${triggerName} step ${stepId} prompt[${index}].include: ${
            error instanceof Error ? error.message : "invalid instruction"
          }`,
          { cause: error },
        );
      }
    }
    if (typeof block.include !== "string") {
      throw new Error(
        `trigger ${triggerName} step ${stepId} prompt[${index}].include: a workflow include is a path under .paseo/workflows`,
      );
    }
    if (resolvedPromptPartials === undefined) {
      throw new Error(
        `trigger ${triggerName} step ${stepId} prompt[${index}].include: this configuration was compiled without a prompt partial bundle, so no include can be resolved`,
      );
    }
    const path = validatePromptPartialPathForCompilation(block.include);
    const partial = resolvedPromptPartials.get(path);
    if (partial === undefined) {
      throw new Error(
        `trigger ${triggerName} step ${stepId} prompt[${index}].include: partial ${path} was not resolved at the exact configuration commit`,
      );
    }
    if (
      partial.path !== path ||
      partial.contentHash !== hashPromptPartialContent(partial.content)
    ) {
      throw new Error(`prompt partial ${path} has invalid resolved content evidence`);
    }
    return {
      kind: "partial" as const,
      path,
      content: partial.content,
      contentHash: partial.contentHash,
    };
  });
}

function validatePromptPartialPathForCompilation(value: string): string {
  try {
    return validatePromptPartialPath(value);
  } catch (error) {
    throw new Error(
      `prompt include path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function compileValues(trigger: AuthoredTrigger): Readonly<Record<string, Expression>> {
  const values: Record<string, Expression> = {};
  for (const [name, source] of Object.entries(trigger.values ?? {})) {
    assertIdentifier(name, `value name on trigger ${trigger.name}`);
    values[name] = compileAt(["triggers", trigger.name, "values", name], () =>
      parseExpression(source),
    );
  }
  return values;
}

function compileInputs(trigger: AuthoredTrigger): Readonly<Record<string, CompiledInput>> {
  const compiled: Record<string, CompiledInput> = {};
  for (const [name, input] of Object.entries(trigger.inputs ?? {})) {
    assertIdentifier(name, `input name on trigger ${trigger.name}`);
    if (input.required === true && input.default !== undefined) {
      throw new Error(
        `trigger ${trigger.name} input ${name} cannot be both required and defaulted`,
      );
    }
    if (!matchesInputType(input.default, input.type)) {
      throw new Error(`trigger ${trigger.name} input ${name} default does not match type`);
    }
    if (input.choices !== undefined) {
      if (input.choices.some((choice) => !matchesInputType(choice, input.type))) {
        throw new Error(`trigger ${trigger.name} input ${name} choices do not match type`);
      }
      if (
        input.default !== undefined &&
        !input.choices.some((choice) => choice === input.default)
      ) {
        throw new Error(`trigger ${trigger.name} input ${name} default is not an allowed choice`);
      }
    }
    compiled[name] = {
      type: input.type,
      required: input.required ?? false,
      ...(input.default === undefined ? {} : { default: input.default }),
      ...(input.choices === undefined ? {} : { choices: input.choices }),
    };
  }
  return compiled;
}

function validateInputFilters(
  trigger: AuthoredTrigger,
  inputs: Readonly<Record<string, CompiledInput>>,
): void {
  for (const [name, value] of Object.entries(trigger.filters?.inputs ?? {})) {
    const definition = inputs[name];
    if (definition === undefined) {
      throw new Error(`trigger ${trigger.name} input filter references undeclared input ${name}`);
    }
    if (!matchesInputType(value, definition.type)) {
      throw new Error(`trigger ${trigger.name} input filter ${name} does not match type`);
    }
    if (
      definition.choices !== undefined &&
      !definition.choices.some((choice) => choice === value)
    ) {
      throw new Error(`trigger ${trigger.name} input filter ${name} is not an allowed choice`);
    }
  }
}

function validateEnvironmentInputChoices(
  trigger: AuthoredTrigger,
  inputs: Readonly<Record<string, CompiledInput>>,
  environmentNames: ReadonlySet<string>,
  environments: ReadonlyMap<string, AuthoredEnvironment>,
): void {
  for (const step of trigger.steps) {
    if ("wait" in step || isAuthoredEnvStep(step) || "http" in step || "notice" in step) continue;
    const reference = DYNAMIC_INPUT_REFERENCE.exec(step.environment);
    if (reference === null) continue;
    const input = inputs[reference[1]!];
    if (input === undefined || input.choices === undefined) continue;
    for (const choice of input.choices) {
      if (typeof choice !== "string" || !environmentNames.has(choice)) {
        throw new Error(
          `trigger ${trigger.name} step ${step.id} environment choice ${String(choice)} is not a configured environment`,
        );
      }
      if (environments.get(choice)?.kind !== "daemon") {
        throw new Error(
          `trigger ${trigger.name} step ${step.id} environment choice ${choice} must be a daemon environment`,
        );
      }
    }
  }
}

function validateCompiledInputs(trigger: CompiledTrigger): void {
  for (const [name, input] of Object.entries(trigger.inputs)) {
    if (!INPUT_NAME.test(name)) throw new Error(`invalid input name: ${name}`);
    if (!matchesInputType(input.default, input.type)) {
      throw new Error(`input ${name} default does not match type`);
    }
    if (input.required && input.default !== undefined) {
      throw new Error(`input ${name} cannot be both required and defaulted`);
    }
    if (input.choices !== undefined) {
      if (input.choices.some((choice) => !matchesInputType(choice, input.type))) {
        throw new Error(`input ${name} choices do not match type`);
      }
      if (
        input.default !== undefined &&
        !input.choices.some((choice) => choice === input.default)
      ) {
        throw new Error(`input ${name} default is not an allowed choice`);
      }
    }
  }
  for (const [name, value] of Object.entries(trigger.filters?.inputs ?? {})) {
    const input = trigger.inputs[name];
    if (input === undefined || !matchesInputType(value, input.type)) {
      throw new Error(`input filter ${name} does not match a declared input`);
    }
    if (input.choices !== undefined && !input.choices.some((choice) => choice === value)) {
      throw new Error(`input filter ${name} is not an allowed choice`);
    }
  }
}

function validateExpressionContract(
  triggerName: string,
  trigger: CompiledTrigger,
  environments: ReadonlyMap<string, AuthoredEnvironment | CompiledEnvironment>,
): void {
  const environmentNames = new Set(environments.keys());
  const stepOrdinals = new Map(trigger.steps.map((step, ordinal) => [step.id, ordinal]));
  const valueNames = new Set(Object.keys(trigger.values));
  const visiting = new Set<string>();

  for (const name of valueNames) validateValue(name);
  for (const [ordinal, step] of trigger.steps.entries()) {
    if (step.condition !== undefined)
      compileAt(["triggers", triggerName, "steps", step.id, "if"], () =>
        validateExpression(step.condition!, ordinal, `step ${step.id} if`, false),
      );
    if (step.notice !== undefined) {
      compileAt(["triggers", triggerName, "steps", step.id, "notice"], () =>
        validateTemplate(step.notice!.text, ordinal, `step ${step.id} notice`, false),
      );
    }
    if (isCompiledStaticStep(step)) continue;
    compileAt(["triggers", triggerName, "steps", step.id, "environment"], () => {
      validateTemplate(step.environment, ordinal, `step ${step.id} environment`, true);
      validateEnvironmentSelection(step.environment, ordinal, step.id);
    });
    if (step.title !== undefined)
      compileAt(["triggers", triggerName, "steps", step.id, "title"], () =>
        validateTitleTemplate(step.title!, `step ${step.id} title`),
      );
    if ("selector" in step.agent) {
      const selection = step.agent;
      compileAt(["triggers", triggerName, "steps", step.id, "agent"], () => {
        validateTemplate(selection.selector, ordinal, `step ${step.id} agent`, true);
        const selected = finiteTemplateValues(selection.selector, ordinal);
        if (selected === undefined) {
          throw new Error(`step ${step.id} agent must resolve from finite choices`);
        }
        for (const name of selected) {
          if (!Object.hasOwn(selection.choices, name)) {
            throw new Error(`step ${step.id} agent resolves to unknown named agent ${name}`);
          }
        }
      });
    }
    for (const [index, block] of step.prompt.entries()) {
      if (block.kind === "include") continue;
      compileAt(["triggers", triggerName, "steps", step.id, "prompt", index], () =>
        validateTemplate(
          block.kind === "text" ? block.value : block.content,
          ordinal,
          `step ${step.id} prompt[${index}]`,
          false,
          true,
        ),
      );
    }
  }

  function validateEnvironmentSelection(template: string, ordinal: number, stepId: string): void {
    const selected = finiteTemplateValues(template, ordinal);
    if (selected === undefined) {
      throw new Error(`step ${stepId} environment must resolve from finite choices`);
    }
    for (const name of selected) {
      if (!environmentNames.has(name)) {
        throw new Error(`step ${stepId} resolves to unknown environment ${name}`);
      }
      if (environments.get(name)?.kind !== "daemon") {
        throw new Error(`step ${stepId} environment ${name} must be a daemon environment`);
      }
    }
  }

  function finiteTemplateValues(template: string, ordinal: number): readonly string[] | undefined {
    let results = [""];
    let cursor = 0;
    while (cursor < template.length) {
      const start = template.indexOf(EXPRESSION_START, cursor);
      if (start < 0) return results.map((prefix) => prefix + template.slice(cursor));
      const end = template.indexOf(EXPRESSION_END, start + EXPRESSION_START.length);
      if (end < 0) return undefined;
      const literal = template.slice(cursor, start);
      const choices = finiteExpressionValues(
        parseExpression(template.slice(start + EXPRESSION_START.length, end)),
        ordinal,
      );
      if (choices === undefined) return undefined;
      results = results.flatMap((prefix) =>
        choices.map((choice) => prefix + literal + interpolatedValue(choice)),
      );
      cursor = end + EXPRESSION_END.length;
    }
    return [...new Set(results)];
  }

  function finiteExpressionValues(
    expression: Expression,
    ordinal: number,
  ): readonly JsonValue[] | undefined {
    if (expression.kind === "literal") return [expression.value];
    if (expression.kind === "path") return finitePathValues(expression.value, ordinal);
    if (expression.kind === "not") {
      const values = finiteExpressionValues(expression.value, ordinal);
      return values === undefined ? undefined : [...new Set(values.map((value) => !truthy(value)))];
    }
    const left = finiteExpressionValues(expression.left, ordinal);
    const right = finiteExpressionValues(expression.right, ordinal);
    if (left === undefined || right === undefined) return undefined;
    const results: JsonValue[] = [];
    for (const leftValue of left) {
      for (const rightValue of right) {
        results.push(finiteBinaryValue(expression.operator, leftValue, rightValue));
      }
    }
    return uniqueJsonValues(results);
  }

  function finitePathValues(
    reference: ExpressionPath,
    ordinal: number,
  ): readonly JsonValue[] | undefined {
    if (reference.namespace === "paseo") {
      if (!Array.isArray(reference.path)) return undefined;
      const input = trigger.inputs[reference.path[1]];
      if (input?.choices === undefined) return undefined;
      return input.required || input.default !== undefined
        ? input.choices
        : [...input.choices, null];
    }
    if (reference.namespace === "values") {
      const value = trigger.values[reference.name];
      return value === undefined ? undefined : finiteExpressionValues(value, ordinal);
    }
    const referencedOrdinal = stepOrdinals.get(reference.stepId);
    if (referencedOrdinal === undefined || referencedOrdinal >= ordinal) return undefined;
    const referenced = trigger.steps[referencedOrdinal];
    const output =
      referenced !== undefined && "output" in referenced ? referenced.output : undefined;
    return output === undefined ? undefined : finiteSchemaChoices(output.schema, reference.path);
  }

  function validateValue(name: string, ordinal = Number.POSITIVE_INFINITY): void {
    if (visiting.has(name)) throw new Error(`value dependency cycle includes ${name}`);
    const expression = trigger.values[name];
    if (expression === undefined) throw new Error(`value ${name} is unavailable`);
    visiting.add(name);
    validateExpression(expression, ordinal, `value ${name}`, false);
    visiting.delete(name);
  }

  function validateExpression(
    expression: Expression,
    ordinal: number,
    path: string,
    authorityBearing: boolean,
    contextAllowed = false,
  ): void {
    for (const reference of expressionPaths(expression)) {
      validateReference(reference, ordinal, path, authorityBearing, contextAllowed);
      if (reference.namespace === "values") validateValue(reference.name, ordinal);
    }
    if (authorityBearing && !isFiniteAuthorityExpression(expression)) {
      throw new Error(
        `${path} uses an agent-produced authority without provable finite choices; use a finite enum or const`,
      );
    }
  }

  function validateTemplate(
    value: string | undefined,
    ordinal: number,
    path: string,
    authorityBearing: boolean,
    contextAllowed = false,
  ): void {
    if (value === undefined) return;
    let cursor = 0;
    while (true) {
      const start = value.indexOf(EXPRESSION_START, cursor);
      if (start < 0) return;
      const end = value.indexOf(EXPRESSION_END, start + EXPRESSION_START.length);
      if (end < 0) throw new Error(`${path} uses an unterminated expression`);
      const expression = parseExpression(value.slice(start + EXPRESSION_START.length, end));
      validateExpression(expression, ordinal, path, authorityBearing, contextAllowed);
      cursor = end + EXPRESSION_END.length;
    }
  }

  function validateReference(
    reference: ExpressionPath,
    ordinal: number,
    path: string,
    authorityBearing: boolean,
    contextAllowed: boolean,
  ): void {
    if (reference.namespace === "paseo") {
      if (reference.path === "prompt") {
        if (authorityBearing)
          throw new Error(`${path} uses paseo.prompt in an authority-bearing field`);
        return;
      }
      if (reference.path === "context") {
        if (!contextAllowed) throw new Error(`${path} uses paseo.context outside a step prompt`);
        return;
      }
      if (reference.path[0] === "execution") {
        throw new Error(
          `${path} uses paseo.execution outside environment worktree.newBranch or a step title`,
        );
      }
      const inputName = reference.path[1];
      const input = trigger.inputs[inputName];
      if (input === undefined) throw new Error(`${path} references undeclared input ${inputName}`);
      if (authorityBearing && input.choices === undefined) {
        throw new Error(`${path} uses input ${inputName} without finite choices`);
      }
      return;
    }
    if (reference.namespace === "values") {
      if (!valueNames.has(reference.name))
        throw new Error(`${path} references undeclared value ${reference.name}`);
      return;
    }
    validateStepOutputReference(trigger, stepOrdinals, reference, ordinal, path, authorityBearing);
  }

  function isFiniteAuthorityExpression(expression: Expression): boolean {
    if (expression.kind === "literal") return expression.value !== null;
    if (expression.kind === "not") return true;
    if (expression.kind === "binary") {
      if (expression.operator === "==" || expression.operator === "!=") return true;
      return (
        isFiniteAuthorityExpression(expression.left) &&
        isFiniteAuthorityExpression(expression.right)
      );
    }
    const reference = expression.value;
    if (reference.namespace === "paseo") {
      return (
        reference.path !== "prompt" && trigger.inputs[reference.path[1]]?.choices !== undefined
      );
    }
    if (reference.namespace === "values") {
      const value = trigger.values[reference.name];
      return value !== undefined && isFiniteAuthorityExpression(value);
    }
    const referencedOrdinal = stepOrdinals.get(reference.stepId);
    const step = referencedOrdinal === undefined ? undefined : trigger.steps[referencedOrdinal];
    if (step === undefined || isCompiledStaticStep(step) || step.output === undefined) return false;
    return hasFiniteSchemaChoices(step.output.schema, reference.path);
  }

  if (
    trigger.steps.some((step) => !isCompiledStaticStep(step) && step.environment.includes("${{")) &&
    environmentNames.size === 0
  ) {
    throw new Error(`trigger ${triggerName} has no configured environments`);
  }
}

function compileAt<T>(path: readonly (string | number)[], operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof HubConfigurationCompilationError) throw error;
    throw new HubConfigurationCompilationError(
      path,
      error instanceof Error ? error.message : "invalid Hub configuration",
      { cause: error },
    );
  }
}

function truthy(value: JsonValue): boolean {
  return value !== false && value !== null && value !== 0 && value !== "";
}

function interpolatedValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function uniqueJsonValues(values: readonly JsonValue[]): JsonValue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finiteBinaryValue(
  operator: Extract<Expression, { kind: "binary" }>["operator"],
  left: JsonValue,
  right: JsonValue,
): JsonValue {
  if (operator === "&&") return truthy(left) ? right : left;
  if (operator === "||") return truthy(left) ? left : right;
  if (operator === "??") return left === null ? right : left;
  if (operator === "==") return JSON.stringify(left) === JSON.stringify(right);
  return JSON.stringify(left) !== JSON.stringify(right);
}

function matchesInputType(value: JsonPrimitive | undefined, type: AuthoredInput["type"]): boolean {
  if (value === undefined) return true;
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "boolean";
}

function validateCompiledContract(config: CompiledHubConfig): void {
  validateEnvironmentTemplates(config.environments);
  const environmentIds = new Set<string>();
  const environments = new Map<string, CompiledEnvironment>();
  for (const environment of config.environments) {
    if (environmentIds.has(environment.name)) {
      throw new Error(`duplicate environment id: ${environment.name}`);
    }
    if (!IDENTIFIER.test(environment.name))
      throw new Error(`invalid environment name: ${environment.name}`);
    environmentIds.add(environment.name);
    environments.set(environment.name, environment);
  }

  const triggerIds = new Set<string>();
  for (const trigger of config.triggers) {
    if (triggerIds.has(trigger.name)) throw new Error(`duplicate trigger id: ${trigger.name}`);
    triggerIds.add(trigger.name);
    if (trigger.steps.length === 0)
      throw new Error(`trigger ${trigger.name} must contain a workflow step`);
    const stepIds = new Set<string>();
    for (const step of trigger.steps) {
      if (stepIds.has(step.id)) throw new Error(`duplicate step id: ${step.id}`);
      stepIds.add(step.id);
      if (isCompiledStaticStep(step)) {
        if (step.condition !== undefined && !isExpression(step.condition)) {
          throw new Error(`step ${step.id} contains an invalid condition`);
        }
        continue;
      }
      if (!environmentIds.has(step.environment) && !step.environment.includes(EXPRESSION_START)) {
        throw new Error(`step ${step.id} references unknown environment ${step.environment}`);
      }
      validateCompiledStepEnvironment(step, trigger.inputs, environments);
      validateStepEnvironmentContract(trigger.name, trigger.on, step.id, step.env, step.github);
      if (step.idleTimeoutMs > step.maxRuntimeMs) {
        throw new Error(`step ${step.id} idle_timeout must not exceed max_runtime`);
      }
      validateCompiledPromptBlocks(step);
      if (step.condition !== undefined && !isExpression(step.condition)) {
        throw new Error(`step ${step.id} contains an invalid condition`);
      }
      if (step.output !== undefined)
        validateOutputSchema(step.output.schema, `step ${step.id} output.schema`);
    }
    validateCompiledInputs(trigger);
    for (const [name, expression] of Object.entries(trigger.values)) {
      assertIdentifier(name, "value name");
      if (!isExpression(expression))
        throw new Error(`value ${name} contains an invalid expression`);
    }
    validateExpressionContract(trigger.name, trigger, environments);
    validateTriggerLaunchSecurity(trigger);
  }
}

/**
 * A title is presentation: it may carry the execution id so runs of one trigger can be told
 * apart, but never event text, so prompt, context, and inputs are refused by name.
 */
function validateTitleTemplate(title: string, path: string): void {
  for (const reference of expressionPathsInTemplate(title)) {
    if (reference.namespace !== "paseo") {
      throw new Error(
        `${path} uses ${reference.namespace}; a title supports only paseo.execution.id`,
      );
    }
    const name = typeof reference.path === "string" ? reference.path : reference.path[0];
    if (name === "execution") continue;
    throw new Error(
      `${path} uses paseo.${name}; a title is presentation and supports only paseo.execution.id`,
    );
  }
}

function validateEnvironmentTemplates(
  environments: readonly (AuthoredEnvironment | CompiledEnvironment)[],
): void {
  for (const environment of environments) {
    if (environment.kind !== "daemon" || environment.worktree?.mode !== "branch-off") continue;
    const newBranch = environment.worktree.newBranch;
    compileAt(["environments", environment.name, "worktree", "newBranch"], () => {
      validateExecutionTemplate(newBranch);
    });
  }
}

function validateCompiledStepEnvironment(
  step: CompiledAgentStep,
  inputs: Readonly<Record<string, CompiledInput>>,
  environments: ReadonlyMap<string, CompiledEnvironment>,
): void {
  const staticEnvironment = environments.get(step.environment);
  if (staticEnvironment !== undefined && staticEnvironment.kind !== "daemon") {
    throw new Error(`step ${step.id} environment ${step.environment} must be a daemon environment`);
  }
  const environmentReference = DYNAMIC_INPUT_REFERENCE.exec(step.environment);
  const environmentInput =
    environmentReference === null ? undefined : inputs[environmentReference[1]!];
  for (const choice of environmentInput?.choices ?? []) {
    if (typeof choice !== "string") continue;
    const choiceEnvironment = environments.get(choice);
    if (choiceEnvironment !== undefined && choiceEnvironment.kind !== "daemon") {
      throw new Error(`step ${step.id} environment choice ${choice} must be a daemon environment`);
    }
  }
}

function validateStepEnvironmentContract(
  triggerName: string,
  triggerEvent: string,
  stepId: string,
  env: Readonly<Record<string, string>> | undefined,
  github: CompiledGitHubAuthority | undefined,
): void {
  if (env !== undefined) {
    for (const [key, value] of Object.entries(env)) {
      validateConnectionTemplate(value, `trigger ${triggerName} step ${stepId} env.${key}`);
      if (github !== undefined && isGitHubAuthorityEnvironmentKey(key)) {
        throw new Error(
          `trigger ${triggerName} step ${stepId} env.${key}: reserved by the step-level github authority; remove it from env`,
        );
      }
    }
  }
  if (github !== undefined) {
    validateGitHubAuthority(github, `trigger ${triggerName} step ${stepId} github`);
    if (github.repositories === undefined && !triggerEvent.startsWith("github.")) {
      throw new Error(
        `trigger ${triggerName} step ${stepId} github.repositories is required for non-GitHub triggers; list the repositories explicitly`,
      );
    }
  }
}

function validateCompiledPromptBlocks(step: CompiledAgentStep): void {
  for (const block of step.prompt) {
    if (block.kind === "include") {
      try {
        validatePromptInstructionPath(block.path);
        if (block.root !== undefined) assertInstructionRoot(block.root);
      } catch (error) {
        throw new Error(
          `step ${step.id} contains an unsafe prompt instruction: ${
            error instanceof Error ? error.message : "invalid instruction"
          }`,
          { cause: error },
        );
      }
      continue;
    }
    if (block.kind !== "partial") continue;
    try {
      validateResolvedPromptPartialPath(block.path);
    } catch {
      throw new Error(`step ${step.id} contains an unsafe resolved prompt partial path`);
    }
    if (hashPromptPartialContent(block.content) !== block.contentHash) {
      throw new Error(`step ${step.id} contains invalid prompt partial content evidence`);
    }
  }
}

function validateOutputSchema(schema: JsonValue, path: string): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error(`${path} must be a JSON Schema object`);
  }
  try {
    compileJsonSchema(schema);
  } catch (error) {
    throw new Error(
      `${path} is invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

function hasFiniteSchemaChoices(schema: JsonValue, path: readonly string[]): boolean {
  return finiteSchemaChoices(schema, path) !== undefined;
}

function isExpression(value: unknown): value is Expression {
  if (!isRecord(value) || typeof value["kind"] !== "string") return false;
  if (value["kind"] === "literal") return isJsonValue(value["value"]);
  if (value["kind"] === "path") return isExpressionPath(value["value"]);
  if (value["kind"] === "not") return isExpression(value["value"]);
  return (
    value["kind"] === "binary" &&
    ["==", "!=", "&&", "||", "??"].includes(String(value["operator"])) &&
    isExpression(value["left"]) &&
    isExpression(value["right"])
  );
}

function isExpressionPath(value: unknown): boolean {
  if (!isRecord(value) || typeof value["namespace"] !== "string") return false;
  if (value["namespace"] === "values") return typeof value["name"] === "string";
  if (value["namespace"] === "steps") {
    return (
      typeof value["stepId"] === "string" &&
      Array.isArray(value["path"]) &&
      value["path"].every((part) => typeof part === "string")
    );
  }
  return (
    value["namespace"] === "paseo" &&
    (value["path"] === "prompt" ||
      (Array.isArray(value["path"]) &&
        value["path"].length === 2 &&
        ((value["path"][0] === "inputs" && typeof value["path"][1] === "string") ||
          (value["path"][0] === "execution" && value["path"][1] === "id"))))
  );
}

function validateAuthoredIds(config: AuthoredHubConfig): void {
  const environments = new Set<string>();
  for (const environment of config.environments) {
    assertIdentifier(environment.name, "environment name");
    if (environments.has(environment.name))
      throw new Error(`duplicate environment id: ${environment.name}`);
    environments.add(environment.name);
  }
  const triggers = new Set<string>();
  for (const trigger of config.triggers) {
    assertIdentifier(trigger.name, "trigger name");
    if (triggers.has(trigger.name)) throw new Error(`duplicate trigger id: ${trigger.name}`);
    triggers.add(trigger.name);
    const steps = new Set<string>();
    for (const step of trigger.steps) {
      assertIdentifier(step.id, "step id");
      if (steps.has(step.id)) throw new Error(`duplicate step id: ${step.id}`);
      steps.add(step.id);
    }
  }
}

function validateTriggerLaunchSecurity(trigger: CompiledTrigger): void {
  if (isEditorEvent(trigger.on) && eventDefinition(trigger.on).origin === "hub") return;
  // A project scout is an intentionally autonomous, project-scoped policy. Every other
  // externally-originated Linear action remains actor-allowlisted below.
  if (trigger.on === "linear.issue_entered_scope") {
    if (trigger.filters?.project === undefined) {
      throw new Error(
        `trigger ${trigger.name} requires filters.project for linear.issue_entered_scope`,
      );
    }
    return;
  }
  if ((trigger.filters?.from_users?.length ?? 0) === 0) {
    throw new Error(
      `trigger ${trigger.name} requires a non-empty filters.from_users allowlist for externally sourced events`,
    );
  }
}

function assertIdentifier(value: string, kind: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`invalid ${kind}: ${value}`);
}

function rejectRemovedFields(raw: unknown): void {
  rejectTimeoutAnywhere(raw);
  if (!isRecord(raw)) return;
  const triggers: unknown = raw["triggers"];
  if (!Array.isArray(triggers)) return;
  triggers.forEach((trigger: unknown, index) => rejectTriggerFields(trigger, index));
}

function rejectTriggerFields(value: unknown, index: number): void {
  if (!isRecord(value)) return;
  for (const field of [
    "environment",
    "agent",
    "prompt",
    "idle_timeout",
    "auto_archive",
    "background",
    "allow_outputs",
  ]) {
    if (field in value) {
      throw new Error(
        `triggers[${index}].${field}: trigger-level ${field} was removed; put ${field} on the relevant workflow step`,
      );
    }
  }
}

function rejectTimeoutAnywhere(value: unknown, path = "configuration"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectTimeoutAnywhere(child, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  if ("timeout" in value) throw new Error(`${path}.timeout: timeout was removed; use max_runtime`);
  for (const [key, child] of Object.entries(value)) rejectTimeoutAnywhere(child, `${path}.${key}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function cloneJsonValue(value: unknown): JsonValue {
  const cloned: unknown = structuredClone(value);
  if (!isJsonValue(cloned)) throw new Error("value is not valid JSON");
  return cloned;
}

function cloneJsonObject(value: Record<string, JsonValue>): Record<string, JsonValue> {
  const cloned = cloneJsonValue(value);
  if (!isRecord(cloned)) throw new Error("value is not a JSON object");
  return cloned as Record<string, JsonValue>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const child of value as unknown[]) deepFreeze(child);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function hashConfiguration(configuration: unknown): string {
  return createHash("sha256").update(stableJson(configuration)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "undefined";
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
