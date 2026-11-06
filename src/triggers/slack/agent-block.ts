import { z } from "zod";

const SlackAgentPromptItemSchema = z
  .object({
    title: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

/**
 * The opt-in block on one agent reaction.
 *
 * Absent means the run keeps the legacy assistant status. `feedback: true` lets the
 * agent put its own choices on the card when it finishes active or suspended.
 */
export const SlackAgentBlockSchema = z
  .object({
    display: z.enum(["plan", "timeline"]),
    session_title: z.string().min(1).max(200).optional(),
    plan_title: z.string().min(1).optional(),
    prompts: z
      .object({
        title: z.string().min(1).optional(),
        items: z.array(SlackAgentPromptItemSchema).min(1).max(4),
      })
      .strict()
      .optional(),
    feedback: z.boolean().optional(),
  })
  .strict()
  .superRefine((block, context) => {
    if (block.display === "timeline" && block.plan_title !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["plan_title"],
        message: "plan_title is only valid when display is plan.",
      });
    }
  });

export type SlackAgentBlock = z.infer<typeof SlackAgentBlockSchema>;

/** Output types the compiler grants when a step opts into the agent surface. */
export const SLACK_AGENT_OUTPUT_TYPES = [
  "slack.agent.stage",
  "slack.agent.tool",
  "slack.agent.say",
  "slack.agent.finish",
  "slack.agent.fail",
  "slack.agent.title",
  "slack.agent.prompts",
] as const;

export type SlackAgentOutputType = (typeof SLACK_AGENT_OUTPUT_TYPES)[number];

export interface SlackAgentPromptDraft {
  /** Stable only inside the form. The YAML stores the title and the message. */
  id: string;
  title: string;
  message: string;
}

/** Form state for `slack_agent`. Off omits the block. */
export interface SlackAgentDraft {
  enabled: boolean;
  display: "plan" | "timeline";
  sessionTitle: string;
  planTitle: string;
  promptsTitle: string;
  prompts: SlackAgentPromptDraft[];
  /** Lets the agent send choice buttons. Off omits `feedback` from the YAML. */
  feedback: boolean;
}

/**
 * Whether every selected event can host the Slack agent surface.
 *
 * @param events - Events the trigger runs for
 * @returns True when each one is a Slack message or mention
 */
export function eventsAllowSlackAgent(events: readonly string[]): boolean {
  return (
    events.length > 0 &&
    events.every((event) => event === "slack.message" || event === "slack.mention")
  );
}

/**
 * The draft a new agent starts from. The surface stays off.
 *
 * @returns An empty Slack agent draft
 */
export function blankSlackAgentDraft(): SlackAgentDraft {
  return {
    enabled: false,
    display: "plan",
    sessionTitle: "",
    planTitle: "",
    promptsTitle: "",
    prompts: [],
    feedback: false,
  };
}

/**
 * Reads a parsed block into the form.
 *
 * @param block - `slack_agent` from the document, when the reaction has one
 * @returns The form draft. Off when the block is absent
 */
export function projectSlackAgentDraft(block: SlackAgentBlock | undefined): SlackAgentDraft {
  if (block === undefined) return blankSlackAgentDraft();
  return {
    enabled: true,
    display: block.display,
    sessionTitle: block.session_title ?? "",
    planTitle: block.plan_title ?? "",
    promptsTitle: block.prompts?.title ?? "",
    prompts: (block.prompts?.items ?? []).map((item, index) => ({
      id: `prompt-${String(index)}`,
      title: item.title,
      message: item.message,
    })),
    feedback: block.feedback === true,
  };
}

/**
 * The YAML block for this draft, or nothing when the surface is off or the events are not Slack.
 *
 * Empty prompt rows are left out. A row needs both a title and a message before it is written.
 *
 * @param draft - Form state
 * @param events - Events the trigger runs for
 * @returns The block to store, or undefined to omit it
 */
export function slackAgentBlockFromDraft(
  draft: SlackAgentDraft,
  events: readonly string[],
): SlackAgentBlock | undefined {
  if (!draft.enabled || !eventsAllowSlackAgent(events)) return undefined;
  const items = draft.prompts.flatMap((item) => {
    const title = item.title.trim();
    const message = item.message.trim();
    return title.length > 0 && message.length > 0 ? [{ title, message }] : [];
  });
  const promptsTitle = draft.promptsTitle.trim();
  const sessionTitle = draft.sessionTitle.trim();
  const planTitle = draft.planTitle.trim();
  return {
    display: draft.display,
    ...(sessionTitle.length === 0 ? {} : { session_title: sessionTitle }),
    ...(draft.display === "plan" && planTitle.length > 0 ? { plan_title: planTitle } : {}),
    ...(items.length === 0
      ? {}
      : {
          prompts: {
            ...(promptsTitle.length === 0 ? {} : { title: promptsTitle }),
            items,
          },
        }),
    ...(draft.feedback ? { feedback: true as const } : {}),
  };
}

/**
 * Field errors for one Slack agent draft.
 *
 * @param draft - Form state
 * @param key - Error key. The flow prefixes it with the reaction id
 * @returns Errors keyed for the form
 */
export function slackAgentDraftErrors(draft: SlackAgentDraft, key: string): Record<string, string> {
  if (!draft.enabled) return {};
  const found: Record<string, string> = {};
  if (draft.sessionTitle.trim().length > 200) {
    found[key] = "Session title must be 200 characters or fewer.";
  }
  if (draft.prompts.length > 4) {
    found[key] = "Suggested prompts are limited to four.";
  }
  const partial = draft.prompts.some((item) => {
    const title = item.title.trim().length > 0;
    const message = item.message.trim().length > 0;
    return title !== message;
  });
  if (partial) found[key] = "Each suggested prompt needs a title and a message.";
  return found;
}

/**
 * Grants the seven agent-surface outputs when this step opted in.
 *
 * A step without the block keeps the list it already had. The grants have no `max`.
 *
 * @param allowOutputs - Outputs already on the step
 * @param slackAgent - The step's block, when it has one
 * @returns The same list, plus the surface outputs when the block is present
 */
export function withSlackAgentOutputs<Output extends { readonly type: string }>(
  allowOutputs: readonly Output[],
  slackAgent: SlackAgentBlock | undefined,
): readonly (Output | { type: SlackAgentOutputType; required: false })[] {
  if (slackAgent === undefined) return allowOutputs;
  const present = new Set(allowOutputs.map((output) => output.type));
  const added = SLACK_AGENT_OUTPUT_TYPES.filter((type) => !present.has(type)).map((type) => ({
    type,
    required: false as const,
  }));
  return added.length === 0 ? allowOutputs : [...allowOutputs, ...added];
}

/**
 * The run's output context, with this step's own block or with the run's block removed.
 *
 * The run keeps the first step that opted in, so the opening "Working..." follows that step.
 * A step that did not opt in does not see that block, so its tools stay hidden.
 *
 * @param outputContext - Output context stored on the run
 * @param stepAgent - The block compiled onto this step, when it has one
 * @returns The context the step's tools should see
 */
export function outputContextForSlackAgentStep(
  outputContext: unknown,
  stepAgent: SlackAgentBlock | undefined,
): unknown {
  if (!isRecord(outputContext)) return outputContext;
  if (stepAgent === undefined) {
    if (!("slackAgent" in outputContext)) return outputContext;
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(outputContext)) {
      if (key !== "slackAgent") rest[key] = value;
    }
    return rest;
  }
  return { ...outputContext, slackAgent: stepAgent };
}

/**
 * The first agent step that opted into the surface.
 *
 * @param steps - Compiled steps, in run order
 * @returns That step's block, or undefined when none opted in
 */
export function firstSlackAgentBlock(
  steps: readonly { slackAgent?: SlackAgentBlock | undefined }[],
): SlackAgentBlock | undefined {
  for (const step of steps) {
    if (step.slackAgent !== undefined) return step.slackAgent;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
