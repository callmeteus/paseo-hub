import { RecurrenceSchema } from "../schedule/recurrence.js";
import { z } from "zod";
import { ContinuationSchema } from "../continuation.js";
import { eventDefinition, isEditorEvent } from "./events.js";
import { AuthoredGitHubAuthoritySchema } from "../../config/github-authority.js";
import { SlackMessageRegexSchema, SlackMessageTextSchema } from "../slack/text-filter.js";
import { GuardrailsSchema } from "../../workflows/guardrails.js";
import { eventsAllowSlackAgent, SlackAgentBlockSchema } from "../slack/agent-block.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const WorktreeTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("branch-off"),
    newBranch: z.string().min(1),
    base: z.string().min(1).optional(),
  }),
  z.object({ mode: z.literal("checkout-branch"), branch: z.string().min(1) }),
  z.object({ mode: z.literal("checkout-pr"), prNumber: z.number().int().positive() }),
]);

/** A trigger or choice name: the document's own alphabet, shared with the form that writes one. */
export const IDENTIFIER = /^[a-z][a-z0-9_-]*$/u;
const EVENT_NAME = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/u;
const CONNECTION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const InputValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const TriggerInputSchema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().optional(),
    default: InputValueSchema.optional(),
    choices: z.array(InputValueSchema).min(1).optional(),
  })
  .strict();

export const TriggerFilterSchema = z
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
    project: z.string().min(1).optional(),
    states: z.array(z.string().min(1)).min(1).optional(),
    exclude_labels: z.array(z.string().min(1)).min(1).optional(),
    assignees: z.array(z.string().min(1)).min(1).optional(),
    channels: z.array(z.string().min(1)).optional(),
    from_users: z.array(z.string().min(1)).optional(),
    /** When true, a Slack message from another app can run this trigger. Off when omitted. */
    include_bots: z.boolean().optional(),
    webhook_secret: z.string().min(32).optional(),
    inputs: z.record(z.string(), InputValueSchema).optional(),
  })
  .strict();

export const TriggerEventSchema = z
  .object({
    recurrence: RecurrenceSchema.optional(),
    connection: z.string().regex(CONNECTION_SLUG).optional(),
    filters: TriggerFilterSchema.optional(),
  })
  .strict();

export const TriggerAgentSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
    // ACP feature values. Cursor Fast is the string "false" or "true".
    features: z.record(z.string().min(1), z.string().min(1)).optional(),
    options: z.record(z.string(), z.custom<JsonValue>()).optional(),
  })
  .strict();

export const TriggerAgentSelectionSchema = z.union([
  TriggerAgentSchema,
  z
    .object({
      select: z.string().min(1),
      choices: z.record(z.string().regex(IDENTIFIER), TriggerAgentSchema),
    })
    .strict(),
]);

export const TriggerTargetSchema = z
  .object({
    daemon: z.string().min(1),
    cwd: z.string().min(1),
    worktree: WorktreeTargetSchema.optional(),
  })
  .strict();

export const TriggerOutputSchema = z
  .object({
    max: z.number().int().positive().optional(),
    required: z.boolean().optional(),
  })
  .strict();

const PromptTextPartSchema = z.object({ text: z.string() }).strict();
const PromptIncludeTargetSchema = z.union([
  z.string().min(1),
  z
    .object({
      path: z.string().min(1),
      root: z.string().min(1).optional(),
    })
    .strict(),
]);
const PromptIncludePartSchema = z.object({ include: PromptIncludeTargetSchema }).strict();
const PromptLoadPartSchema = z
  .object({ load: z.object({ root: z.string().min(1) }).strict() })
  .strict();

/**
 * A prompt string, or an ordered list of text, included files, and catalogs.
 *
 * An include is explicit. A load names a directory the run reads into an index.
 * Omitting the list keeps the string prompt and does not read any rule file.
 */
export const TriggerPromptSchema = z
  .union([
    z.string().min(1),
    z.array(z.union([PromptTextPartSchema, PromptIncludePartSchema, PromptLoadPartSchema])).min(1),
  ])
  .superRefine((prompt, context) => {
    if (typeof prompt === "string") return;
    const useful = prompt.some((part) => !("text" in part) || part.text.trim().length > 0);
    if (!useful) {
      context.addIssue({
        code: "custom",
        message: "Instructions are required.",
      });
    }
  });

export type TriggerPrompt = z.infer<typeof TriggerPromptSchema>;

export type AuthoredPromptBlock =
  | { text: string }
  | { include: string }
  | { include: { path: string; root?: string } }
  | { load: { root: string } };

/**
 * The prompt blocks the workflow compiler already accepts.
 *
 * @param prompt - String or list from the automation YAML
 * @returns One text block, or the list in YAML order
 */
export function authoredPromptBlocks(prompt: TriggerPrompt): AuthoredPromptBlock[] {
  if (typeof prompt === "string") return [{ text: prompt }];
  return prompt.map((part) => {
    if ("text" in part) return { text: part.text };
    if ("include" in part) {
      if (typeof part.include === "string") return { include: part.include };
      const include: { path: string; root?: string } = { path: part.include.path };
      if (part.include.root !== undefined) include.root = part.include.root;
      return { include };
    }
    return { load: { root: part.load.root } };
  });
}

const AgentReactionFields = {
  agent: TriggerAgentSelectionSchema,
  continuation: ContinuationSchema.default({ mode: "conversation" }),
  /** Workspace title template: literal text plus `${{ paseo.execution.id }}`. */
  title: z.string().min(1).optional(),
  prompt: TriggerPromptSchema,
  max_runtime: z.string().min(1).default("2h"),
  idle_timeout: z.string().min(1).default("10m"),
  startup_timeout: z.string().min(1).optional(),
  env: z.record(z.string().min(1), z.string()).optional(),
  github: AuthoredGitHubAuthoritySchema.optional(),
  output: z
    .object({ schema: z.record(z.string(), z.unknown()) })
    .strict()
    .optional(),
  outputs: z.record(z.string().regex(EVENT_NAME), TriggerOutputSchema).optional(),
  /** Opt-in Slack agent session. Absent keeps the legacy assistant status. */
  slack_agent: SlackAgentBlockSchema.optional(),
  auto_archive: z.boolean().default(true),
  background: z.boolean().default(false),
};

/**
 * Rails Hub enforces when this run sends a message.
 * Each entry is `{ id, options }`. `options` is optional and typed by `id`.
 * Omitted means no extra restriction.
 */
const optionalGuardrails = GuardrailsSchema.optional();

export const TriggerRunSchema = z
  .object({
    target: TriggerTargetSchema,
    ...AgentReactionFields,
    guardrails: optionalGuardrails,
  })
  .strict();

export const AgentReactionSchema = z
  .object({
    id: z.string().regex(IDENTIFIER).optional(),
    ...AgentReactionFields,
  })
  .strict();

export const WaitReactionSchema = z
  .object({
    id: z.string().regex(IDENTIFIER).optional(),
    wait: z
      .object({
        for: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const EnvReactionSchema = z
  .object({
    id: z.string().regex(IDENTIFIER).optional(),
    env: z
      .object({
        files: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict();

export const HttpReactionSchema = z
  .object({
    id: z.string().regex(IDENTIFIER).optional(),
    http: z
      .object({
        method: z.enum(["GET", "POST"]),
        url: z.string().startsWith("https://"),
        number_from_prompt: z.literal(true),
        path: z.enum(["assign"]).optional(),
        headers: z.record(z.string().min(1), z.string().min(1)),
      })
      .strict()
      .superRefine((request, context) => {
        if (Object.keys(request.headers).length === 0) {
          context.addIssue({
            code: "custom",
            path: ["headers"],
            message: "headers needs a value.",
          });
        }
        if (request.method === "POST" && request.path !== "assign") {
          context.addIssue({
            code: "custom",
            path: ["path"],
            message: "POST requires path assign.",
          });
        }
        if (request.path === "assign" && request.method !== "POST") {
          context.addIssue({
            code: "custom",
            path: ["path"],
            message: "assign requires POST.",
          });
        }
      }),
  })
  .strict();

export const NoticeReactionSchema = z
  .object({
    id: z.string().regex(IDENTIFIER).optional(),
    notice: z
      .object({
        text: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type AgentReaction = z.infer<typeof AgentReactionSchema>;
export type WaitReaction = z.infer<typeof WaitReactionSchema>;
export type EnvReaction = z.infer<typeof EnvReactionSchema>;

/**
 * An env reaction names dotenv files. Agent settings are not this shape.
 *
 * @param reaction - One authored reaction
 * @returns Whether the reaction loads env files
 */
export function isEnvReaction(reaction: TriggerReaction): reaction is EnvReaction {
  if (!("env" in reaction) || reaction.env === undefined || !("files" in reaction.env)) {
    return false;
  }
  return Array.isArray(reaction.env.files);
}
export type HttpReaction = z.infer<typeof HttpReactionSchema>;
export type NoticeReaction = z.infer<typeof NoticeReactionSchema>;

export interface ConditionReaction {
  id?: string | undefined;
  if: {
    condition: string;
    then: TriggerReaction[];
    else: TriggerReaction[];
  };
}

export type TriggerReaction =
  | AgentReaction
  | WaitReaction
  | EnvReaction
  | HttpReaction
  | NoticeReaction
  | ConditionReaction;

/**
 * The true branch of a condition. The field name is the YAML key, not a Promise.
 *
 * @param value - Reactions or a schema that run when the condition is true
 * @returns That value under the document field
 */
export function trueBranch<T>(value: T): { then: T } {
  // eslint-disable-next-line unicorn/no-thenable -- YAML field, not a Promise
  return { then: value };
}

export const TriggerReactionSchema: z.ZodType<TriggerReaction> = z.lazy(() =>
  z.union([
    AgentReactionSchema,
    WaitReactionSchema,
    EnvReactionSchema,
    HttpReactionSchema,
    NoticeReactionSchema,
    ConditionReactionSchema,
  ]),
);

const ConditionReactionSchema: z.ZodType<ConditionReaction> = z.lazy(() =>
  z
    .object({
      id: z.string().regex(IDENTIFIER).optional(),
      if: z
        .object({
          condition: z.string().min(1),
          ...trueBranch(z.array(TriggerReactionSchema)),
          else: z.array(TriggerReactionSchema).default([]),
        })
        .strict()
        .superRefine((branch, context) => {
          if (branch.then.length === 0 && branch.else.length === 0) {
            context.addIssue({
              code: "custom",
              path: ["then"],
              message: "A condition needs a true or a false branch.",
            });
          }
        }),
    })
    .strict(),
);

export const FlowRunSchema = z
  .object({
    target: TriggerTargetSchema,
    reactions: z.array(TriggerReactionSchema).min(1),
    guardrails: optionalGuardrails,
  })
  .strict();

type DocumentRun = z.infer<typeof FlowRunSchema> | z.infer<typeof TriggerRunSchema>;

/**
 * True when the run is a reaction flow rather than one agent.
 *
 * @param run - Authored run block
 * @returns Whether the block lists reactions
 */
export function isFlowRun(run: DocumentRun): run is z.infer<typeof FlowRunSchema> {
  return "reactions" in run;
}

/**
 * The single-agent run, or an error when the document lists reactions.
 *
 * @param run - Authored run block
 * @returns The agent run
 */
export function singleAgentRun(run: DocumentRun): z.infer<typeof TriggerRunSchema> {
  if ("reactions" in run) throw new Error("expected a single agent run");
  return run;
}

/**
 * Parses one run shape and keeps that shape's field errors.
 *
 * A union reports only "Invalid input" when both shapes fail, which hides `run.background`
 * and the other fields a single-agent document already validates.
 *
 * @param value - Raw `run` block
 * @param context - Document parse context
 * @returns The parsed run, or `z.NEVER` when the chosen shape rejects it
 */
function parseDocumentRun(value: unknown, context: z.RefinementCtx): DocumentRun {
  const schema =
    typeof value === "object" && value !== null && "reactions" in value
      ? FlowRunSchema
      : TriggerRunSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        message: issue.message,
        path: [...issue.path],
      });
    }
    return z.NEVER;
  }
  return parsed.data;
}

const RunSchema = z.unknown().transform((value, context) => parseDocumentRun(value, context));

export const TriggerDocumentSchema = z
  .object({
    name: z.string().regex(IDENTIFIER),
    enabled: z.boolean().default(true),
    on: z.record(z.string().regex(EVENT_NAME), TriggerEventSchema),
    inputs: z.record(z.string().regex(IDENTIFIER), TriggerInputSchema).optional(),
    /** A distinct whole-trigger deadline; new one-run triggers normally omit it. */
    max_runtime: z.string().min(1).optional(),
    run: RunSchema,
  })
  .strict()
  .superRefine((trigger, context) => {
    for (const [event, definition] of Object.entries(trigger.on)) {
      refineTriggerEvent(event, definition, trigger.inputs, context);
    }
    if (Object.keys(trigger.on).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["on"],
        message: "at least one event is required",
      });
    }
    if (
      "agent" in trigger.run &&
      "choices" in trigger.run.agent &&
      Object.keys(trigger.run.agent.choices).length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run", "agent", "choices"],
        message: "at least one agent choice is required",
      });
    }
    if (runHasSlackAgent(trigger.run) && !eventsAllowSlackAgent(Object.keys(trigger.on))) {
      context.addIssue({
        code: "custom",
        path: ["run", "slack_agent"],
        message: "slack_agent is only valid when every event is slack.message or slack.mention.",
      });
    }
  });

export type TriggerDocument = z.infer<typeof TriggerDocumentSchema>;

function runHasSlackAgent(run: DocumentRun): boolean {
  if ("slack_agent" in run && run.slack_agent !== undefined) return true;
  if (!("reactions" in run)) return false;
  return reactionsHaveSlackAgent(run.reactions);
}

function reactionsHaveSlackAgent(reactions: readonly TriggerReaction[]): boolean {
  for (const reaction of reactions) {
    if ("slack_agent" in reaction && reaction.slack_agent !== undefined) return true;
    if ("if" in reaction && reactionsHaveSlackAgent([...reaction.if.then, ...reaction.if.else])) {
      return true;
    }
  }
  return false;
}

function refineTriggerEvent(
  event: string,
  definition: z.infer<typeof TriggerEventSchema>,
  inputs: TriggerDocument["inputs"],
  context: z.RefinementCtx,
): void {
  if (event === "schedule.tick") {
    refineScheduleEvent(event, definition, inputs, context);
    return;
  }
  if (event === "webhook.received") {
    refineWebhookEvent(event, definition, context);
  } else if (definition.recurrence !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["on", event, "recurrence"],
      message: "Recurrence is only supported for schedule.tick.",
    });
  }
  if (!isEditorEvent(event)) return;
  for (const qualifier of eventDefinition(event).qualifiers) {
    const value = definition.filters?.[qualifier.key];
    if (qualifier.required && (value === undefined || value.trim().length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["on", event, "filters", qualifier.key],
        message: `${qualifier.label} is required.`,
      });
    }
  }
}

function refineScheduleEvent(
  event: string,
  definition: z.infer<typeof TriggerEventSchema>,
  inputs: TriggerDocument["inputs"],
  context: z.RefinementCtx,
): void {
  if (
    definition.recurrence === undefined ||
    definition.connection !== undefined ||
    definition.filters !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["on", event],
      message: "Schedule requires recurrence and does not accept connection or filters.",
    });
  }
  // A tick supplies no inputs; it runs with the declared defaults.
  for (const [name, input] of Object.entries(inputs ?? {})) {
    if (input.required !== true) continue;
    context.addIssue({
      code: "custom",
      path: ["inputs", name],
      message: "A trigger with a schedule cannot require an input; give it a default.",
    });
  }
}

function refineWebhookEvent(
  event: string,
  definition: z.infer<typeof TriggerEventSchema>,
  context: z.RefinementCtx,
): void {
  const secret = definition.filters?.webhook_secret;
  if (definition.connection !== undefined || secret === undefined) {
    context.addIssue({
      code: "custom",
      path: ["on", event],
      message: "Webhook requires filters.webhook_secret and does not accept a connection.",
    });
  }
}
