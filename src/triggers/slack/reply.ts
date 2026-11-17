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
  /** Locale of the trigger's system messages. Absent keeps only the always-on checks. */
  locale: z.string().min(1).optional(),
});

/**
 * Builds the `reply` executor.
 *
 * The text is checked before anything reaches the workspace: a reply the model has to
 * rewrite becomes a tool error and nothing is posted. Local attachment links are uploaded
 * to the same channel and thread, then taken out of the text.
 *
 * The checks follow the trigger locale carried on the output context. With no locale the
 * reply is only checked for a link outside the attachment directory, an invalid mention,
 * and a raw Slack id.
 */
export function createSlackReplyExecutor(options: { client: SlackBotClient }): OutputExecutor {
  return async function executeSlackReply(input) {
    const args = SlackReplyArgsSchema.parse(input.args);
    const context = SlackReplyOutputContextSchema.parse(input.outputContext);
    const checked = checkOutboundText(args.content, context.locale);
    if (!checked.ok) throw new SlackOutboundTextError(checked.reason);
    const { text, files } = extractLocalAttachments(args.content);
    await uploadAttachments(options.client, context, files);
    if (text.length === 0) return;
    await options.client.sendMessage({
      organizationId: context.organizationId,
      teamId: context.teamId,
      channelId: context.channelId,
      threadTs: context.threadTs,
      content: text,
    });
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
