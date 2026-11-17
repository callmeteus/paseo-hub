import { stat } from "node:fs/promises";
import { z } from "zod";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import { reportFailure } from "../../failures/index.js";
import type { SlackBotClient } from "./client.js";
import { SlackOutboundTextError, checkOutboundText, extractLocalAttachments } from "./outbound.js";

const SlackReplyArgsSchema = z.object({ content: z.string().min(1) });
const SlackReplyOutputContextSchema = z.object({
  organizationId: z.string().min(1),
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
});

/**
 * Builds the `reply` executor.
 *
 * The text is checked before anything reaches the workspace: a reply the model has to
 * rewrite becomes a tool error and nothing is posted. Local attachment links are uploaded
 * to the same channel and thread, then taken out of the text.
 */
export function createSlackReplyExecutor(options: { client: SlackBotClient }): OutputExecutor {
  return async function executeSlackReply(input) {
    const args = SlackReplyArgsSchema.parse(input.args);
    const context = SlackReplyOutputContextSchema.parse(input.outputContext);
    const checked = checkOutboundText(args.content);
    if (!checked.ok) throw new SlackOutboundTextError(checked.reason);
    const { text, files } = extractLocalAttachments(args.content);
    await uploadAttachments(options.client, context, files);
    if (text.length === 0) return;
    await options.client.sendMessage({ ...context, content: text });
  };
}

/**
 * Uploads each local attachment that still exists, and drops the ones that do not.
 *
 * A file the run already deleted, or a Slack client with no upload, must not stop the
 * reply: only the link is lost.
 */
async function uploadAttachments(
  client: SlackBotClient,
  context: { organizationId: string; teamId: string; channelId: string; threadTs: string },
  files: readonly string[],
): Promise<void> {
  if (client.uploadFile === undefined) return;
  for (const path of files) {
    try {
      if (!(await exists(path))) continue;
      await client.uploadFile({ ...context, path });
    } catch (error) {
      reportFailure(
        error,
        { operation: "slack.reply.upload", component: "providers", provider: "slack" },
        { diagnostic: { teamId: context.teamId, channelId: context.channelId, path } },
      );
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    return entry.isFile();
  } catch {
    return false;
  }
}
