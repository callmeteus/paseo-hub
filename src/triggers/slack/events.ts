import { z } from "zod";

const SlackIdSchema = z.string().min(1).max(255);
const SlackTimestampSchema = z.string().regex(/^\d+\.\d+$/u);
const SlackAttachmentMetadataSchema = z.object({
  id: SlackIdSchema,
  filename: z.string().min(1).max(255),
  contentType: z.string().max(255).nullable(),
  size: z.number().int().nonnegative().nullable(),
});
export const SlackUrlVerificationSchema = z
  .object({
    type: z.literal("url_verification"),
    challenge: z.string().min(1),
    api_app_id: SlackIdSchema.optional(),
  })
  .passthrough();

export const SlackEventCallbackSchema = z
  .object({
    type: z.literal("event_callback"),
    team_id: SlackIdSchema,
    api_app_id: SlackIdSchema,
    event_id: SlackIdSchema,
    event_time: z.number().int().nonnegative(),
    event: z.unknown(),
  })
  .passthrough();

const SlackAppMentionSchema = z
  .object({
    type: z.literal("app_mention"),
    user: SlackIdSchema,
    channel: SlackIdSchema,
    text: z.string(),
    ts: SlackTimestampSchema,
    event_ts: SlackTimestampSchema,
    thread_ts: SlackTimestampSchema.optional(),
    bot_id: SlackIdSchema.optional(),
    subtype: z.string().optional(),
    files: z
      .array(
        z
          .object({
            id: SlackIdSchema,
            name: z.string().min(1).max(255).optional(),
            title: z.string().min(1).max(255).optional(),
            mimetype: z.string().max(255).optional(),
            size: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const SlackChannelMessageSchema = z
  .object({
    type: z.literal("message"),
    user: SlackIdSchema.optional(),
    channel: SlackIdSchema,
    text: z.string().optional(),
    ts: SlackTimestampSchema,
    event_ts: SlackTimestampSchema,
    thread_ts: SlackTimestampSchema.optional(),
    bot_id: SlackIdSchema.optional(),
    subtype: z.string().optional(),
    channel_type: z.enum(["channel", "group", "im", "mpim"]).optional(),
    files: z
      .array(
        z
          .object({
            id: SlackIdSchema,
            name: z.string().min(1).max(255).optional(),
            title: z.string().min(1).max(255).optional(),
            mimetype: z.string().max(255).optional(),
            size: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const NormalizedSlackMentionEventSchema = z.object({
  type: z.enum(["mention", "message"]),
  id: SlackIdSchema,
  teamId: SlackIdSchema,
  appId: SlackIdSchema,
  channelId: SlackIdSchema,
  messageTs: SlackTimestampSchema,
  threadTs: SlackTimestampSchema.nullable(),
  eventTs: SlackTimestampSchema,
  eventTime: z.number().int().nonnegative(),
  content: z.string(),
  author: z.object({ id: SlackIdSchema, username: z.string().min(1).max(255).optional() }),
  createdAt: z.string(),
  attachments: z.array(SlackAttachmentMetadataSchema).default([]),
});

export type NormalizedSlackMentionEvent = z.infer<typeof NormalizedSlackMentionEventSchema>;

export function normalizeSlackEvent(
  envelope: z.infer<typeof SlackEventCallbackSchema>,
): NormalizedSlackMentionEvent | undefined {
  const mention = SlackAppMentionSchema.safeParse(envelope.event);
  if (mention.success) {
    if (mention.data.bot_id !== undefined || mention.data.subtype === "bot_message") {
      return undefined;
    }
    return normalizedSlackEvent(envelope, "mention", {
      channel: mention.data.channel,
      text: mention.data.text,
      ts: mention.data.ts,
      eventTs: mention.data.event_ts,
      threadTs: mention.data.thread_ts ?? null,
      user: mention.data.user,
      files: mention.data.files,
    });
  }

  const message = SlackChannelMessageSchema.safeParse(envelope.event);
  if (!message.success) return undefined;
  if (message.data.user === undefined) return undefined;
  if (message.data.bot_id !== undefined || message.data.subtype !== undefined) return undefined;
  if (message.data.channel_type === "im" || message.data.channel_type === "mpim") return undefined;
  // A thread reply carries a parent timestamp. The message that opened the thread uses its own.
  if (message.data.thread_ts !== undefined && message.data.thread_ts !== message.data.ts) {
    return undefined;
  }
  return normalizedSlackEvent(envelope, "message", {
    channel: message.data.channel,
    text: message.data.text ?? "",
    ts: message.data.ts,
    eventTs: message.data.event_ts,
    threadTs: null,
    user: message.data.user,
    files: message.data.files,
  });
}

function normalizedSlackEvent(
  envelope: z.infer<typeof SlackEventCallbackSchema>,
  type: "mention" | "message",
  event: {
    channel: string;
    text: string;
    ts: string;
    eventTs: string;
    threadTs: string | null;
    user: string;
    files:
      | {
          id: string;
          name?: string | undefined;
          title?: string | undefined;
          mimetype?: string | undefined;
          size?: number | undefined;
        }[]
      | undefined;
  },
): NormalizedSlackMentionEvent {
  return NormalizedSlackMentionEventSchema.parse({
    type,
    id: envelope.event_id,
    teamId: envelope.team_id,
    appId: envelope.api_app_id,
    channelId: event.channel,
    messageTs: event.ts,
    threadTs: event.threadTs,
    eventTs: event.eventTs,
    eventTime: envelope.event_time,
    content: event.text,
    author: { id: event.user },
    createdAt: new Date(Number(event.ts) * 1_000).toISOString(),
    attachments: (event.files ?? []).map((file) => ({
      id: file.id,
      filename: file.name ?? file.title ?? file.id,
      contentType: file.mimetype ?? null,
      size: file.size ?? null,
    })),
  });
}
