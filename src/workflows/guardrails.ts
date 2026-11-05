import { z } from "zod";

/**
 * Blocks a Slack post whose channel is not the channel of the triggering Slack event.
 *
 * A different channel is refused. A Slack post with no source channel is refused.
 */
export const SLACK_SAME_CHANNEL = "slack.same_channel" as const;

/**
 * Blocks a Slack post outside the thread of the triggering message.
 *
 * That thread is the event's thread timestamp, or the message timestamp when the
 * event is already the thread root. A top-level channel message or another thread
 * is refused. A Slack post with no source thread is refused.
 */
export const SLACK_SAME_THREAD = "slack.same_thread" as const;

export const GUARDRAIL_IDS = [SLACK_SAME_CHANNEL, SLACK_SAME_THREAD] as const;

export type GuardrailId = (typeof GUARDRAIL_IDS)[number];

/** Known rail ids. Any other string is rejected by the workflow schema. */
export const GuardrailIdSchema = z.enum(GUARDRAIL_IDS);

/**
 * Options with no knobs.
 *
 * Unknown keys are rejected. A future rail replaces this object with the fields
 * that rail actually reads.
 */
const EmptyGuardrailOptionsSchema = z.object({}).strict();

type EmptyGuardrailOptions = z.infer<typeof EmptyGuardrailOptionsSchema>;

/**
 * A rail whose options object has no fields.
 *
 * The document writes `{ id, options }`. `options` may be omitted. A bare string
 * is not a rail. A future rail with knobs writes its own object schema and joins
 * {@link GuardrailSchema} instead of using this helper.
 *
 * @param id - Stable rail id
 * @returns Object schema for that id
 */
function emptyOptionsRail<const Id extends GuardrailId>(id: Id) {
  return z
    .object({
      id: z.literal(id),
      options: EmptyGuardrailOptionsSchema.optional(),
    })
    .strict();
}

const SlackSameChannelGuardrailSchema = emptyOptionsRail(SLACK_SAME_CHANNEL);
const SlackSameThreadGuardrailSchema = emptyOptionsRail(SLACK_SAME_THREAD);

/**
 * One rail. `id` selects the options object. These two ids have an empty object.
 * A bare string is rejected.
 */
export const GuardrailSchema = z.discriminatedUnion("id", [
  SlackSameChannelGuardrailSchema,
  SlackSameThreadGuardrailSchema,
]);

/** One or more rails. An empty list is not a way to say "no rails". Omit the field instead. */
export const GuardrailsSchema = z.array(GuardrailSchema).min(1);

/** A rail stored on the run. `options` is absent when the author omitted it. */
export type Guardrail = z.infer<typeof GuardrailSchema>;

/**
 * Hub tools that post into a Slack channel.
 *
 * The agent calls `hub.reply`; the output type on that call is `slack.reply`.
 * `slack.react` targets a channel too, so the same rails apply.
 */
const SLACK_POST_TOOL_TYPES: ReadonlySet<string> = new Set(["slack.reply", "slack.react"]);

export class GuardrailRefusal extends Error {
  readonly rail: string;

  constructor(rail: string, message: string) {
    super(message);
    this.name = "GuardrailRefusal";
    this.rail = rail;
  }
}

/** Channel and thread the triggering Slack message came from. */
export interface SlackTriggerSource {
  channelId?: string | undefined;
  /** `thread_ts` when the message is inside a thread. Absent when the message is the root. */
  threadTs?: string | undefined;
  /** `ts` of the triggering message. This is the thread when the message is the root. */
  messageTs?: string | undefined;
}

/** Channel and thread a Slack post is about to use. No thread means a top-level channel message. */
export interface SlackPostDestination {
  channelId?: string | undefined;
  threadTs?: string | undefined;
}

export type SlackGuardrailAction =
  | { kind: "slack.post"; destination: SlackPostDestination }
  | { kind: "other" };

/** Arguments one Slack rail reads when a post is about to be sent. */
interface SlackRailCall<Options> {
  source: SlackTriggerSource | undefined;
  destination: SlackPostDestination;
  /** Parsed options for this id. Absent when the author omitted `options`. */
  options: Options | undefined;
}

/**
 * Slack rails applied when a post is about to be sent.
 *
 * The id selects the enforcer and the options object. `slack.same_channel` and
 * `slack.same_thread` have no knobs, so their enforcers do not read `options`.
 */
const SLACK_RAILS = {
  [SLACK_SAME_CHANNEL]: {
    enforce(call: SlackRailCall<EmptyGuardrailOptions>): void {
      enforceSameChannel(call.source, call.destination);
    },
  },
  [SLACK_SAME_THREAD]: {
    enforce(call: SlackRailCall<EmptyGuardrailOptions>): void {
      enforceSameThread(call.source, call.destination);
    },
  },
} satisfies Record<GuardrailId, { enforce: (call: SlackRailCall<EmptyGuardrailOptions>) => void }>;

export interface SlackGuardrailCheck {
  guardrails: readonly Guardrail[] | undefined;
  action: SlackGuardrailAction;
  source: SlackTriggerSource | undefined;
}

/**
 * Refuses a Slack post that leaves the triggering channel or thread.
 *
 * Omitted `guardrails` allows the send. A rail on an action that is not a Slack
 * post does nothing, so a GitHub reply is left alone. A Slack post whose triggering
 * event has no channel or thread is refused. Empty `options` does not change these
 * two rails.
 *
 * @param check - Rails, the action about to be sent, and the triggering Slack event
 * @throws {GuardrailRefusal} When a Slack rail refuses the send
 */
export function enforceSlackGuardrails(check: SlackGuardrailCheck): void {
  if (check.guardrails === undefined || check.guardrails.length === 0) return;
  // GitHub, Discord, and any other non-Slack send ignore Slack rails.
  if (check.action.kind !== "slack.post") return;

  for (const rail of check.guardrails) {
    enforceRail(rail, check.source, check.action.destination);
  }
}

/**
 * Applies one rail to a Slack post.
 *
 * The id selects the enforcer. Options for that id were already parsed. An id
 * this process does not know refuses the send.
 *
 * @param rail - Rail copied from the run
 * @param source - Triggering Slack message, when the event has one
 * @param destination - Channel and thread the post would use
 * @throws {GuardrailRefusal} When the rail refuses the post, or the id is unknown
 */
function enforceRail(
  rail: Guardrail,
  source: SlackTriggerSource | undefined,
  destination: SlackPostDestination,
): void {
  if (rail.id === SLACK_SAME_CHANNEL) {
    SLACK_RAILS[SLACK_SAME_CHANNEL].enforce({ source, destination, options: rail.options });
    return;
  }
  if (rail.id === SLACK_SAME_THREAD) {
    SLACK_RAILS[SLACK_SAME_THREAD].enforce({ source, destination, options: rail.options });
    return;
  }
  refuse(recordedRailId(rail), "this guardrail id is not recognized.");
}

/**
 * Id of a rail the typed union does not know.
 *
 * The schema rejects that id before a run is stored. This still refuses the
 * send when a Slack post arrives with one.
 *
 * @param rail - Value left after the known ids
 * @returns The id string, or `guardrail` when the value has none
 */
function recordedRailId(rail: object): string {
  if (!isRecord(rail)) return "guardrail";
  return readId(rail["id"]) ?? "guardrail";
}

/**
 * The check for one output-tool call.
 *
 * The destination is the channel and thread the Slack post will use. The source
 * is the triggering event, not that destination.
 *
 * @param input - Rails stored on the run, the output type, and both contexts
 * @returns The arguments `enforceSlackGuardrails` decides
 */
export function slackGuardrailCheck(input: {
  guardrails: readonly Guardrail[] | undefined;
  toolType: string;
  triggerContext: unknown;
  outputContext: unknown;
}): SlackGuardrailCheck {
  return {
    guardrails: input.guardrails,
    action: slackAction(input.toolType, input.outputContext),
    source: readSlackTriggerSource(input.triggerContext),
  };
}

function enforceSameChannel(
  source: SlackTriggerSource | undefined,
  destination: SlackPostDestination,
): void {
  const sourceChannel = source?.channelId;
  if (sourceChannel === undefined) {
    refuse(SLACK_SAME_CHANNEL, "the triggering event has no Slack channel.");
  }
  const destinationChannel = destination.channelId;
  if (destinationChannel === undefined) {
    refuse(SLACK_SAME_CHANNEL, "the Slack message has no destination channel.");
  }
  if (destinationChannel !== sourceChannel) {
    refuse(
      SLACK_SAME_CHANNEL,
      "the destination channel is not the channel of the triggering event.",
    );
  }
}

function enforceSameThread(
  source: SlackTriggerSource | undefined,
  destination: SlackPostDestination,
): void {
  const sourceThread = source === undefined ? undefined : (source.threadTs ?? source.messageTs);
  if (sourceThread === undefined) {
    refuse(SLACK_SAME_THREAD, "the triggering event has no Slack thread.");
  }
  const destinationThread = destination.threadTs;
  // chat.postMessage without thread_ts lands in the channel, outside the thread.
  if (destinationThread === undefined) {
    refuse(SLACK_SAME_THREAD, "a top-level channel message is outside the triggering thread.");
  }
  if (destinationThread !== sourceThread) {
    refuse(SLACK_SAME_THREAD, "the destination thread is not the thread of the triggering event.");
  }
}

function refuse(rail: string, reason: string): never {
  throw new GuardrailRefusal(rail, `Refused by ${rail}: ${reason}`);
}

function slackAction(toolType: string, outputContext: unknown): SlackGuardrailAction {
  if (!SLACK_POST_TOOL_TYPES.has(toolType)) return { kind: "other" };
  return { kind: "slack.post", destination: readSlackDestination(outputContext) };
}

/**
 * Channel and thread of the Slack event that started the run.
 *
 * A GitHub event, or a Slack event with no trigger message, has no source.
 * The output context is the destination, so it is not used here.
 *
 * @param triggerContext - Provider context stored on the execution
 * @returns The triggering message, or undefined when this event is not that message
 */
function readSlackTriggerSource(triggerContext: unknown): SlackTriggerSource | undefined {
  if (!isRecord(triggerContext) || triggerContext["provider"] !== "slack") return undefined;
  const event = triggerContext["event"];
  if (!isRecord(event)) return undefined;
  const slack = event["slack"];
  if (!isRecord(slack)) return undefined;
  const message = slack["trigger_message"];
  if (!isRecord(message)) return undefined;
  const channel = message["channel"];
  const thread = message["thread"];
  return {
    channelId: isRecord(channel) ? readId(channel["id"]) : undefined,
    threadTs: isRecord(thread) ? readId(thread["ts"]) : undefined,
    messageTs: readId(message["ts"]),
  };
}

function readSlackDestination(outputContext: unknown): SlackPostDestination {
  if (!isRecord(outputContext)) return {};
  return {
    channelId: readId(outputContext["channelId"]),
    threadTs: readId(outputContext["threadTs"]),
  };
}

function readId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id.length === 0 ? undefined : id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
