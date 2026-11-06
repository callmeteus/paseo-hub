import { z } from "zod";
import type {
  AllowedOutput,
  OutputExecutor,
  OutputToolDefinition,
} from "../../execution-capabilities/outputs.js";

const SlackEmojiNameSchema = z
  .string()
  .trim()
  .transform((value) => stripSlackEmojiColons(value))
  .pipe(z.string().regex(/^[a-z0-9_+-]{1,100}$/u));

const SlackReactArgsSchema = z
  .object({
    name: SlackEmojiNameSchema,
    ts: z
      .string()
      .regex(/^\d+\.\d+$/u)
      .optional(),
  })
  .strict();

/**
 * Reaction names that mean the work on this message is finished.
 * Adding one of them takes the eyes off, which is the "still working" mark.
 */
const DONE_REACTION_NAMES = new Set(["white_check_mark", "heavy_check_mark", "check"]);

const SlackReactOutputContextSchema = z.object({
  organizationId: z.string().min(1),
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  messageTs: z.string().min(1),
  threadTs: z.string().min(1).optional(),
});

/**
 * Tool the Slack agent calls when it wants to react.
 * Hub does not add an emoji unless this tool runs.
 */
export const reactOutputTool: OutputToolDefinition = {
  name: "react",
  description:
    "Adds one emoji reaction to a Slack message in this thread. Pass the emoji name without colons, such as eyes. Omit ts to react to the message that started this run. Pass ts only for that message or for the thread root. Adding white_check_mark, heavy_check_mark, or check also removes eyes from that same message. Hub does not add a reaction unless this tool is called.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        description: "Slack emoji name, without surrounding colons.",
      },
      ts: {
        type: "string",
        minLength: 1,
        description:
          "Slack ts of the message to react to. The triggering message, or the thread root. Omit for the triggering message.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

/**
 * Adds the emoji the agent asked for on one message in this thread.
 *
 * @param options - Slack client that performs `reactions.add`
 * @returns Executor for the `slack.react` output
 */
export function createSlackReactExecutor(options: {
  client: {
    addReaction(input: SlackReactionInput): Promise<void>;
    removeReaction(input: SlackReactionInput): Promise<void>;
  };
}): OutputExecutor {
  return async function executeSlackReact(input) {
    const args = SlackReactArgsSchema.parse(input.args);
    const context = SlackReactOutputContextSchema.parse(input.outputContext);
    const target = {
      organizationId: context.organizationId,
      teamId: context.teamId,
      channelId: context.channelId,
      messageTs: reactionMessageTs(args.ts, context),
    };
    await options.client.addReaction({ ...target, name: args.name });
    if (!DONE_REACTION_NAMES.has(args.name)) return;
    try {
      await options.client.removeReaction({ ...target, name: "eyes" });
    } catch (error) {
      // The message was never marked in progress. The finished reaction still stands.
      if (!isMissingReaction(error)) throw error;
    }
  };
}

/**
 * Grants `slack.react` once so a Slack run can react without a preset emoji.
 *
 * @param allowOutputs - Outputs already granted to the step
 * @returns The same list, plus `slack.react` when it was missing
 */
export function appendSlackReactGrant<Output extends { readonly type: string }>(
  allowOutputs: readonly Output[],
): readonly (Output | { type: "slack.react"; required: false })[] {
  if (allowOutputs.some((output) => output.type === "slack.react")) return allowOutputs;
  return [...allowOutputs, { type: "slack.react", required: false }];
}

/**
 * Grants `slack.react` when this launch is answering a Slack message.
 *
 * @param allowOutputs - Outputs stored on the launch
 * @param outputContext - Provider context for the triggering event
 * @returns Outputs the agent may call, including `slack.react` for Slack
 */
export function slackReactGrant(
  allowOutputs: readonly AllowedOutput[],
  outputContext: unknown,
): readonly AllowedOutput[] {
  if (!isSlackOutputContext(outputContext)) return allowOutputs;
  return appendSlackReactGrant(allowOutputs);
}

interface SlackReactionInput {
  organizationId: string;
  teamId: string;
  channelId: string;
  messageTs: string;
  name: string;
}

/**
 * True when Slack says this user has no such reaction on the message.
 *
 * @param error - Failure from `reactions.remove`
 * @returns Whether the eyes were already gone
 */
function isMissingReaction(error: unknown): boolean {
  return error instanceof Error && error.message.includes("no_reaction");
}

/**
 * The message this reaction lands on.
 *
 * The default is the message that started the run. A caller may also name the
 * thread root, which is the first message of a triage thread. Any other ts is
 * refused so a run cannot react outside that pair.
 *
 * @param requested - `ts` from the tool call, when the agent sent one
 * @param context - Channel message and thread root for this run
 * @returns The Slack ts `reactions.add` should use
 */
function reactionMessageTs(
  requested: string | undefined,
  context: { messageTs: string; threadTs?: string | undefined },
): string {
  if (requested === undefined || requested === context.messageTs) return context.messageTs;
  if (requested === context.threadTs) return requested;
  throw new Error("react ts must be the triggering message or the thread root");
}

/**
 * Drops the colon wrapper Slack shows in the composer (`:eyes:`).
 *
 * @param value - Emoji name from the tool argument
 * @returns The name Slack's `reactions.add` accepts
 */
function stripSlackEmojiColons(value: string): string {
  if (value.startsWith(":") && value.endsWith(":") && value.length > 2) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * True when the launch is a Slack thread reply target.
 *
 * @param value - Output context stored on the execution
 * @returns Whether `provider` is `slack`
 */
function isSlackOutputContext(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!("provider" in value)) return false;
  return value.provider === "slack";
}
