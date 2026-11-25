import { z } from "zod";
import type { ProviderEventAcceptance } from "../../../../db/types.js";
import { logger } from "../../../../logger.js";
import { logProviderEventIntake } from "../../../audit.js";
import type { ProviderEventDropReasonCode } from "../../../drop-reason.js";
import type { TriggerHandler } from "../../../index.js";
import { noteSlackAgentSessionStopped } from "../../agent-surface.js";
import {
  describeDroppedSlackEvent,
  normalizeSlackEvent,
  readAgentSessionStopped,
  SlackEventCallbackSchema,
  SLACK_THREAD_SIGNAL_SOURCE,
} from "../../events.js";

export interface SlackEventIntakeOptions {
  appId: string;
  accept(input: {
    teamId: string;
    deliveryId: string;
    signatureHash: string;
    source: string;
    payload: unknown;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
}

export class SlackEventIntakeValidationError extends Error {
  override name = "SlackEventIntakeValidationError";
}

/**
 * A message that cannot open a case can still carry news for the thread it belongs to.
 * Replies and edits have no usable top-level author or carry a parent timestamp, so
 * normal intake drops them. Their text and thread are kept as a small signal instead.
 *
 * @param event - Inner event of an Events API callback
 * @returns The signal payload, or undefined when the event has no thread to point at
 */
const UnknownRecordSchema = z.record(z.string(), z.unknown());

const ThreadSignalSchema = z
  .object({
    channelId: z.string().min(1),
    messageTs: z.string().min(1),
    threadTs: z.string().min(1),
    text: z.string(),
    authorId: z.string().min(1),
    channelType: z.string().optional(),
    botId: z.string().optional(),
    subtype: z.string().optional(),
    fromBot: z.boolean(),
  })
  .strict();

function readThreadSignal(event: unknown): Record<string, unknown> | undefined {
  const parsedEvent = UnknownRecordSchema.safeParse(event);
  if (!parsedEvent.success) return undefined;
  const record = parsedEvent.data;
  const parsedInner = UnknownRecordSchema.safeParse(record["message"]);
  const inner = parsedInner.success ? parsedInner.data : {};
  const botId = record["bot_id"] ?? inner["bot_id"];
  const subtype = record["subtype"];
  const candidate = {
    channelId: record["channel"],
    messageTs: record["ts"],
    threadTs: record["thread_ts"] ?? inner["thread_ts"] ?? inner["ts"] ?? record["ts"],
    text: inner["text"] ?? record["text"],
    authorId: record["user"] ?? inner["user"] ?? botId ?? "unknown",
    channelType: record["channel_type"],
    botId,
    subtype,
    fromBot: botId !== undefined || subtype === "bot_message",
  };
  const parsed = ThreadSignalSchema.safeParse(candidate);
  return parsed.success ? { ...parsed.data } : undefined;
}

/** Transport-blind durable handoff for Slack Events API callbacks. */
export async function intakeSlackEvent(
  payload: unknown,
  signatureHash: string,
  handlers: ReadonlySet<TriggerHandler>,
  options: SlackEventIntakeOptions,
): Promise<void> {
  const callback = SlackEventCallbackSchema.safeParse(payload);
  if (!callback.success) throw new SlackEventIntakeValidationError();
  if (callback.data.api_app_id !== options.appId) {
    throw new SlackEventIntakeValidationError();
  }
  const stopped = readAgentSessionStopped(callback.data);
  if (stopped !== undefined) {
    await noteSlackAgentSessionStopped(stopped);
    return;
  }
  const normalizedEvent = normalizeSlackEvent(callback.data);
  // A dropped message never reaches the trigger log. Say why, without the text.
  if (normalizedEvent === undefined) {
    const dropped = describeDroppedSlackEvent(callback.data.event);
    if (dropped !== undefined) {
      logger.info(
        { provider: "slack", operation: "slack.event.ignore", ...dropped },
        "Slack message ignored",
      );
      const signal = readThreadSignal(callback.data.event);
      if (signal !== undefined) {
        const acceptance = await options.accept({
          teamId: callback.data.team_id,
          deliveryId: `slack-signal-${callback.data.event_id}`,
          signatureHash,
          source: SLACK_THREAD_SIGNAL_SOURCE,
          payload: signal,
          receivedAt: new Date(callback.data.event_time * 1_000),
        });
        logProviderEventIntake({
          provider: "slack",
          source: SLACK_THREAD_SIGNAL_SOURCE,
          deliveryId: `slack-signal-${callback.data.event_id}`,
          resourceId: callback.data.team_id,
          acceptance,
          ...(process.env["NODE_ENV"] === "production" ? { debugHandlerCount: handlers.size } : {}),
        });
      }
    }
    return;
  }

  const source = normalizedEvent.type === "message" ? "slack.message" : "slack.mention";
  const deliveryId = `slack-${normalizedEvent.id}`;
  const acceptance = await options.accept({
    teamId: normalizedEvent.teamId,
    deliveryId,
    signatureHash,
    source,
    payload: normalizedEvent,
    receivedAt: new Date(normalizedEvent.eventTime * 1_000),
    ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" } : {}),
  });
  logProviderEventIntake({
    provider: "slack",
    source,
    deliveryId,
    resourceId: normalizedEvent.teamId,
    acceptance,
    ...(process.env["NODE_ENV"] === "production" ? { debugHandlerCount: handlers.size } : {}),
  });
  const events = acceptance.status === "accepted" ? acceptance.events : [];
  await Promise.all(
    events.flatMap((acceptedEvent) => Array.from(handlers, (handler) => handler(acceptedEvent))),
  );
}
