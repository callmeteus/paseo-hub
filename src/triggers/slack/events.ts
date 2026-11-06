import { z } from "zod";
import {
  readSlackForwardLocators,
  readSlackMessageFiles,
  readSlackMessageLead,
  readSlackMessageText,
} from "./forwarded-message.js";

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

const SlackAssistantThreadLocatorSchema = z.object({
  channel_id: SlackIdSchema,
  thread_ts: SlackTimestampSchema,
});
const SlackAssistantThreadStartedSchema = z
  .object({
    type: z.literal("assistant_thread_started"),
    assistant_thread: SlackAssistantThreadLocatorSchema.extend({
      user_id: SlackIdSchema,
    }),
    event_ts: SlackTimestampSchema,
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
  /** The Slack thread is an app-agent thread, not a channel post. */
  assistantThread: z.boolean().optional(),
  lead: z.string().default(""),
  forwards: z
    .array(
      z.object({
        channelId: SlackIdSchema,
        messageTs: SlackTimestampSchema,
      }),
    )
    .default([]),
  author: z.object({ id: SlackIdSchema, username: z.string().min(1).max(255).optional() }),
  /** True when another Slack app posted the message. Absent on events stored before the flag. */
  fromBot: z.boolean().optional(),
  /**
   * The choice value the person clicked. Absent on a message Slack delivered.
   */
  planDecision: z.string().min(1).max(200).optional(),
  createdAt: z.string(),
  attachments: z.array(SlackAttachmentMetadataSchema).default([]),
});

export type NormalizedSlackMentionEvent = z.infer<typeof NormalizedSlackMentionEventSchema>;

export interface DroppedSlackEvent {
  reason: "bot" | "missing_user" | "subtype" | "direct_message" | "thread_reply";
  eventType: string;
  subtype?: string;
  channelType?: string;
  channelId?: string;
}

/**
 * Describes a message Slack delivered and the intake refused.
 *
 * Reactions and other event types are not messages, so they stay undescribed.
 *
 * @param event - Inner event of an Events API callback
 * @returns The drop, or undefined when this event is not a refused message
 */
export function describeDroppedSlackEvent(event: unknown): DroppedSlackEvent | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  const eventType = event["type"];

  if (eventType !== "message" && eventType !== "app_mention") {
    return undefined;
  }

  const reason = slackEventDropReason(event, eventType);

  if (reason === undefined) {
    return undefined;
  }

  return {
    reason,
    eventType,
    ...optionalString(event, "subtype", "subtype"),
    ...optionalString(event, "channel_type", "channelType"),
    ...optionalString(event, "channel", "channelId"),
  };
}

/**
 * A channel post Slack tags with a subtype that is still the post.
 * `file_share` is a person sending files. Every other subtype is an edit, a join, or a tombstone.
 *
 * @param subtype - Slack message subtype, when the event has one
 * @returns Whether intake should refuse the event for its subtype
 */
function isDroppedMessageSubtype(subtype: unknown): boolean {
  return typeof subtype === "string" && subtype !== "bot_message" && subtype !== "file_share";
}

/**
 * Another Slack app posted in the channel under its own bot user.
 * A webhook with no user stays dropped. The Hub's own user is filtered later.
 *
 * @param event - Inner Slack event
 * @returns Whether this is a channel message from another app
 */
function isForeignAppChannelMessage(event: Record<string, unknown>): boolean {
  if (typeof event["user"] !== "string") return false;
  const subtype = event["subtype"];
  if (typeof subtype === "string" && subtype !== "bot_message") return false;
  return event["bot_id"] !== undefined || subtype === "bot_message";
}

function slackEventDropReason(
  event: Record<string, unknown>,
  eventType: "message" | "app_mention",
): DroppedSlackEvent["reason"] | undefined {
  const foreignApp = eventType === "message" && isForeignAppChannelMessage(event);
  if (!foreignApp && (event["bot_id"] !== undefined || event["subtype"] === "bot_message")) {
    return "bot";
  }

  if (eventType === "app_mention") {
    return undefined;
  }

  if (typeof event["user"] !== "string") {
    return "missing_user";
  }

  if (isDroppedMessageSubtype(event["subtype"])) {
    return "subtype";
  }

  // A person continuing an app-agent thread is the conversation. The bot's own reply is not.
  if (eventType === "message" && readAssistantMessageThread(event) !== undefined) {
    if (event["bot_id"] !== undefined || event["subtype"] === "bot_message") {
      return "bot";
    }
    return undefined;
  }

  const channelType = event["channel_type"];

  if (channelType === "im" || channelType === "mpim") {
    return "direct_message";
  }

  const threadTs = event["thread_ts"];

  // A thread reply carries a parent timestamp. The message that opened the thread uses its own.
  if (typeof threadTs === "string" && threadTs !== event["ts"]) {
    return "thread_reply";
  }

  // The message passed every refusal. Intake keeps it.
  return undefined;
}

function optionalString(
  event: Record<string, unknown>,
  key: string,
  field: "subtype" | "channelType" | "channelId",
): Partial<Pick<DroppedSlackEvent, "subtype" | "channelType" | "channelId">> {
  const value = event[key];

  if (typeof value !== "string" || value.length === 0) {
    return {};
  }

  return { [field]: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStartedAssistantThread(
  event: unknown,
): { channelId: string; threadTs: string; userId: string; eventTs: string } | undefined {
  const parsed = SlackAssistantThreadStartedSchema.safeParse(event);
  if (!parsed.success) return undefined;
  return {
    channelId: parsed.data.assistant_thread.channel_id,
    threadTs: parsed.data.assistant_thread.thread_ts,
    userId: parsed.data.assistant_thread.user_id,
    eventTs: parsed.data.event_ts,
  };
}

/**
 * The thread a user message continues, when that thread is already an app-agent thread.
 *
 * Slack does not repeat `assistant_thread` on later messages. Those arrive as a direct
 * message that already carries the thread timestamp. A reply in a channel does not.
 *
 * @param event - Inner Slack event
 * @returns The assistant channel and thread, or undefined when this is not that message
 */
function readAssistantMessageThread(
  event: Record<string, unknown>,
): { channelId: string; threadTs: string } | undefined {
  if (event["type"] !== "message") return undefined;
  const marked = SlackAssistantThreadLocatorSchema.safeParse(event["assistant_thread"]);
  if (marked.success) {
    return { channelId: marked.data.channel_id, threadTs: marked.data.thread_ts };
  }
  if (event["channel_type"] !== "im") return undefined;
  const channelId = event["channel"];
  const threadTs = event["thread_ts"];
  if (typeof channelId !== "string" || typeof threadTs !== "string") return undefined;
  if (!SlackIdSchema.safeParse(channelId).success) return undefined;
  if (!SlackTimestampSchema.safeParse(threadTs).success) return undefined;
  return { channelId, threadTs };
}

const SlackAgentSessionStoppedSchema = z
  .object({
    type: z.literal("agent_session_stopped"),
    channel: SlackIdSchema,
    thread_ts: SlackTimestampSchema,
  })
  .passthrough();

/**
 * The thread a person stopped, when this callback is `agent_session_stopped`.
 *
 * The event does not open an automation. The intake stops the run for that thread.
 *
 * @param envelope - Events API callback
 * @returns The channel and thread, or undefined when this is some other event
 */
export function readAgentSessionStopped(
  envelope: z.infer<typeof SlackEventCallbackSchema>,
): { teamId: string; channelId: string; threadTs: string } | undefined {
  const parsed = SlackAgentSessionStoppedSchema.safeParse(envelope.event);
  if (!parsed.success) return undefined;
  return {
    teamId: envelope.team_id,
    channelId: parsed.data.channel,
    threadTs: parsed.data.thread_ts,
  };
}

export function normalizeSlackEvent(
  envelope: z.infer<typeof SlackEventCallbackSchema>,
): NormalizedSlackMentionEvent | undefined {
  const started = readStartedAssistantThread(envelope.event);
  if (started !== undefined) {
    return normalizedSlackEvent(envelope, "message", envelope.event, {
      channel: started.channelId,
      ts: started.threadTs,
      eventTs: started.eventTs,
      threadTs: started.threadTs,
      user: started.userId,
      assistantThread: true,
    });
  }

  const mention = SlackAppMentionSchema.safeParse(envelope.event);
  if (mention.success) {
    if (mention.data.bot_id !== undefined || mention.data.subtype === "bot_message") {
      return undefined;
    }
    return normalizedSlackEvent(envelope, "mention", mention.data, {
      channel: mention.data.channel,
      ts: mention.data.ts,
      eventTs: mention.data.event_ts,
      threadTs: mention.data.thread_ts ?? null,
      user: mention.data.user,
    });
  }

  const message = SlackChannelMessageSchema.safeParse(envelope.event);
  if (!message.success) return undefined;
  if (message.data.user === undefined) return undefined;
  // Joins and edits stay out. A file_share is the post itself: Slack marks a message that
  // carries files with that subtype. A card from another app arrives as bot_message and has a user.
  if (isDroppedMessageSubtype(message.data.subtype)) return undefined;
  const assistantThread = isRecord(envelope.event)
    ? readAssistantMessageThread(envelope.event)
    : undefined;
  if (assistantThread !== undefined) {
    if (message.data.bot_id !== undefined || message.data.subtype === "bot_message") {
      return undefined;
    }
    return normalizedSlackEvent(envelope, "message", message.data, {
      channel: assistantThread.channelId,
      ts: message.data.ts,
      eventTs: message.data.event_ts,
      threadTs: assistantThread.threadTs,
      user: message.data.user,
      assistantThread: true,
    });
  }
  if (message.data.channel_type === "im" || message.data.channel_type === "mpim") return undefined;
  // A thread reply carries a parent timestamp. The message that opened the thread uses its own.
  if (message.data.thread_ts !== undefined && message.data.thread_ts !== message.data.ts) {
    return undefined;
  }
  return normalizedSlackEvent(envelope, "message", message.data, {
    channel: message.data.channel,
    ts: message.data.ts,
    eventTs: message.data.event_ts,
    threadTs: null,
    user: message.data.user,
    fromBot: message.data.bot_id !== undefined || message.data.subtype === "bot_message",
  });
}

function normalizedSlackEvent(
  envelope: z.infer<typeof SlackEventCallbackSchema>,
  type: "mention" | "message",
  source: unknown,
  event: {
    channel: string;
    ts: string;
    eventTs: string;
    threadTs: string | null;
    user: string;
    fromBot?: boolean;
    assistantThread?: boolean;
  },
): NormalizedSlackMentionEvent {
  // A forward keeps the original text on the attachment. `text` itself is often empty.
  const files = readSlackMessageFiles(source);
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
    content: readSlackMessageText(source),
    lead: readSlackMessageLead(source),
    forwards: readSlackForwardLocators(source),
    author: { id: event.user },
    ...(event.fromBot === true ? { fromBot: true } : {}),
    ...(event.assistantThread === true ? { assistantThread: true } : {}),
    createdAt: new Date(Number(event.ts) * 1_000).toISOString(),
    attachments: files.map((file) => ({
      id: file.id,
      filename: file.name ?? file.title ?? file.id,
      contentType: file.mimetype ?? null,
      size: file.size ?? null,
    })),
  });
}
