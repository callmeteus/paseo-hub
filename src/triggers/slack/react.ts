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

const SlackReactArgsSchema = z.object({ name: SlackEmojiNameSchema }).strict();

const SlackReactOutputContextSchema = z.object({
  organizationId: z.string().min(1),
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  messageTs: z.string().min(1),
});

/**
 * Tool the Slack agent calls when it wants to react.
 * Hub does not add an emoji unless this tool runs.
 */
export const reactOutputTool: OutputToolDefinition = {
  name: "react",
  description:
    "Adds one emoji reaction to the Slack message that started this run. Pass the emoji name without colons, such as eyes. Hub does not add a reaction unless this tool is called.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        description: "Slack emoji name, without surrounding colons.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

/**
 * Adds the emoji the agent asked for on the triggering Slack message.
 *
 * @param options - Slack client that performs `reactions.add`
 * @returns Executor for the `slack.react` output
 */
export function createSlackReactExecutor(options: {
  client: { addReaction(input: SlackReactionInput): Promise<void> };
}): OutputExecutor {
  return async function executeSlackReact(input) {
    const args = SlackReactArgsSchema.parse(input.args);
    const context = SlackReactOutputContextSchema.parse(input.outputContext);
    await options.client.addReaction({
      organizationId: context.organizationId,
      teamId: context.teamId,
      channelId: context.channelId,
      messageTs: context.messageTs,
      name: args.name,
    });
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
