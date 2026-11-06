import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProviderEventAcceptance } from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import { logger } from "../../logger.js";
import { logProviderEventIntake } from "../audit.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import type { SlackBotClient } from "./client.js";
import { NormalizedSlackMentionEventSchema, SlackUrlVerificationSchema } from "./events.js";
import {
  blocksAfterChoice,
  slackChoiceArrival,
  slackChoiceFromAction,
  type SlackChoice,
} from "./feedback.js";
import {
  SlackEventIntakeValidationError,
  type SlackEventIntakeOptions,
} from "./source/internal/intake.js";
import { verifySlackSignature } from "./webhook.js";

const MAX_BODY_BYTES = 1_048_576;
const SlackIdSchema = z.string().min(1).max(255);
const SlackTimestampSchema = z.string().regex(/^\d+\.\d+$/u);

const SlackBlockActionsSchema = z
  .object({
    type: z.literal("block_actions"),
    api_app_id: SlackIdSchema,
    team: z.object({ id: SlackIdSchema }).passthrough(),
    channel: z.object({ id: SlackIdSchema }).passthrough(),
    user: z
      .object({
        id: SlackIdSchema,
        username: z.string().min(1).max(255).optional(),
      })
      .passthrough(),
    message: z
      .object({
        ts: SlackTimestampSchema,
        thread_ts: SlackTimestampSchema.optional(),
        text: z.string().optional(),
        blocks: z.array(z.unknown()).optional(),
      })
      .passthrough(),
    actions: z
      .array(
        z
          .object({
            action_id: z.string(),
            action_ts: z.string().optional(),
            value: z.string().optional(),
            text: z.object({ text: z.string().optional() }).passthrough().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export interface SettleSlackPlanDecisionInput {
  organizationId: string;
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  text: string;
  blocks: readonly unknown[];
  /** The choice value the agent defined. */
  decision: string;
  /** The button text the person saw. */
  label: string;
}

export interface SlackInteractionIntakeOptions extends SlackEventIntakeOptions {
  settlePlanDecision?: (this: void, input: SettleSlackPlanDecisionInput) => Promise<void>;
}

export interface SlackInteractionIntakeResult {
  /** Runs after the transport has acknowledged the click. */
  settlement?: () => Promise<void>;
}

export interface SlackInteractivityEndpoint extends TriggerSource {
  handle(request: Request): Promise<Response>;
}

/**
 * Replaces the buttons with the choice, or posts that choice in the thread.
 *
 * The decision is already durable. A failed card update does not undo it.
 *
 * @param client - Workspace bot
 * @param input - The card and the decision that was stored
 * @returns Nothing
 */
export async function settleSlackPlanDecision(
  client: Pick<SlackBotClient, "sendMessage" | "updateMessage">,
  input: SettleSlackPlanDecisionInput,
): Promise<void> {
  const blocks = blocksAfterChoice(input.blocks, input.label);
  if (blocks !== undefined && client.updateMessage !== undefined) {
    const updated = await client.updateMessage({
      organizationId: input.organizationId,
      teamId: input.teamId,
      channelId: input.channelId,
      messageTs: input.messageTs,
      text: input.text.length > 0 ? input.text : input.label,
      blocks,
    });
    if (updated.ok) return;
    logger.warn(
      {
        provider: "slack",
        operation: "slack.plan_decision.update",
        error: updated.error,
      },
      "Slack plan card could not be updated",
    );
  }
  try {
    await client.sendMessage({
      organizationId: input.organizationId,
      teamId: input.teamId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      content: input.label,
    });
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "slack.plan_decision.post",
        component: "triggers",
        provider: "slack",
      },
      { scrubValues: [] },
    );
  }
}

/**
 * Accepts one choice click and enqueues it on the card's thread.
 *
 * A second click on the same card reuses the receipt. The caller settles the card
 * only when this click is the one the receipt stored.
 *
 * @param payload - Slack `block_actions` body
 * @param signatureHash - Hash of the signature or socket envelope
 * @param handlers - Trigger handlers registered on this source
 * @param options - App id, accept, and the card update
 * @returns A settlement to run after the ack, when this click is the stored one
 */
export async function intakeSlackInteraction(
  payload: unknown,
  signatureHash: string,
  handlers: ReadonlySet<TriggerHandler>,
  options: SlackInteractionIntakeOptions,
): Promise<SlackInteractionIntakeResult> {
  const type = readType(payload);
  if (type !== "block_actions") return {};
  const parsed = SlackBlockActionsSchema.safeParse(payload);
  if (!parsed.success) {
    logger.info(
      { provider: "slack", operation: "slack.interaction.ignore" },
      "Slack interaction ignored",
    );
    return {};
  }
  if (parsed.data.api_app_id !== options.appId) throw new SlackEventIntakeValidationError();
  const action = parsed.data.actions
    .map((candidate) => ({ candidate, choice: slackChoiceFromAction(candidate) }))
    .find((item) => item.choice !== undefined);
  if (action?.choice === undefined) return {};
  const choice = action.choice;

  const cardTs = parsed.data.message.ts;
  const eventTs =
    action.candidate.action_ts !== undefined &&
    SlackTimestampSchema.safeParse(action.candidate.action_ts).success
      ? action.candidate.action_ts
      : cardTs;
  const threadTs = parsed.data.message.thread_ts ?? cardTs;
  const event = NormalizedSlackMentionEventSchema.parse({
    type: "message",
    id: `feedback-${parsed.data.channel.id}-${cardTs}`,
    teamId: parsed.data.team.id,
    appId: parsed.data.api_app_id,
    channelId: parsed.data.channel.id,
    messageTs: eventTs,
    threadTs,
    eventTs,
    eventTime: Math.floor(Number(eventTs)),
    content: slackChoiceArrival(choice),
    author:
      parsed.data.user.username === undefined
        ? { id: parsed.data.user.id }
        : { id: parsed.data.user.id, username: parsed.data.user.username },
    planDecision: choice.value,
    createdAt: new Date(Number(eventTs) * 1000).toISOString(),
  });
  const deliveryId = `slack-feedback-${event.teamId}-${event.channelId}-${cardTs}`;
  const acceptance = await options.accept({
    teamId: event.teamId,
    deliveryId,
    signatureHash,
    source: "slack.message",
    payload: event,
    receivedAt: new Date(event.eventTime * 1_000),
    ...(handlers.size === 0
      ? { dropReason: "configuration_unavailable" satisfies ProviderEventDropReasonCode }
      : {}),
  });
  logProviderEventIntake({
    provider: "slack",
    source: "slack.message",
    deliveryId,
    resourceId: event.teamId,
    acceptance,
  });
  const events = acceptance.status === "accepted" ? acceptance.events : [];
  await Promise.all(
    events.flatMap((acceptedEvent) => Array.from(handlers, (handler) => handler(acceptedEvent))),
  );
  const settlement = settlementFor(acceptance, choice, parsed.data, options);
  return settlement === undefined ? {} : { settlement };
}

/**
 * Verifies a Slack interactivity request and accepts a plan-card click.
 *
 * URL verification is JSON. A click is a form field named `payload`. The 200
 * returns after the click is stored, without waiting for the card to update.
 *
 * @param options - Signing secret, app id, and the durable accept
 * @returns The HTTP source mounted at `/api/integrations/slack/interactivity`
 */
export function createSlackInteractivitySource(
  options: SlackInteractionIntakeOptions & { signingSecret: string; now?: () => number },
): SlackInteractivityEndpoint {
  const handlers = new Set<TriggerHandler>();
  return {
    async handle(request) {
      const verified = await verifyInteractionRequest(request, options);
      if (verified instanceof Response) return verified;
      return handleVerifiedInteraction(verified, handlers, options);
    },
    async start(handler) {
      handlers.add(handler);
    },
    async stop() {
      handlers.clear();
    },
  };
}

function settlementFor(
  acceptance: ProviderEventAcceptance,
  choice: Pick<SlackChoice, "label" | "value">,
  payload: z.infer<typeof SlackBlockActionsSchema>,
  options: SlackInteractionIntakeOptions,
): (() => Promise<void>) | undefined {
  const settle = options.settlePlanDecision;
  if (settle === undefined || acceptance.status !== "accepted") return undefined;
  const stored = acceptance.events[0];
  if (stored === undefined) return undefined;
  const parsed = NormalizedSlackMentionEventSchema.safeParse(stored.payload);
  if (!parsed.success || parsed.data.planDecision !== choice.value) return undefined;
  const input: SettleSlackPlanDecisionInput = {
    organizationId: stored.organizationId,
    teamId: payload.team.id,
    channelId: payload.channel.id,
    messageTs: payload.message.ts,
    threadTs: payload.message.thread_ts ?? payload.message.ts,
    text: payload.message.text ?? "",
    blocks: payload.message.blocks ?? [],
    decision: choice.value,
    label: choice.label,
  };
  return () => settle(input);
}

async function verifyInteractionRequest(
  request: Request,
  options: { signingSecret: string; now?: () => number },
): Promise<{ payload: unknown; signatureHash: string } | Response> {
  const signature = request.headers.get("x-slack-signature");
  const timestamp = request.headers.get("x-slack-request-timestamp");
  if (signature === null || timestamp === null) {
    reportRejection("signature_headers_missing", 401, options.signingSecret);
    return new Response("Unauthorized", { status: 401 });
  }
  const body = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  if (!verifySlackSignature(options.signingSecret, timestamp, body, signature, options.now?.())) {
    reportRejection("signature_verification_failed", 401, options.signingSecret, signature);
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    return {
      payload: parseInteractionBody(body),
      signatureHash: createHash("sha256").update(signature).digest("hex"),
    };
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "slack.interactivity.parse",
        component: "triggers",
        provider: "slack",
        status: 400,
      },
      { status: 400, scrubValues: [options.signingSecret] },
    );
    return Response.json({ error: "request body must be a Slack interaction" }, { status: 400 });
  }
}

async function handleVerifiedInteraction(
  verified: { payload: unknown; signatureHash: string },
  handlers: Set<TriggerHandler>,
  options: SlackInteractionIntakeOptions & { signingSecret: string },
): Promise<Response> {
  const type = readType(verified.payload);
  if (type === "url_verification") {
    const challenge = SlackUrlVerificationSchema.safeParse(verified.payload);
    if (
      !challenge.success ||
      (challenge.data.api_app_id !== undefined && challenge.data.api_app_id !== options.appId)
    ) {
      reportRejection("invalid_url_verification", 400, options.signingSecret);
      return new Response("Bad Request", { status: 400 });
    }
    return Response.json({ challenge: challenge.data.challenge });
  }
  try {
    const result = await intakeSlackInteraction(
      verified.payload,
      verified.signatureHash,
      handlers,
      options,
    );
    if (result.settlement !== undefined) {
      void result.settlement().catch((error: unknown) => {
        reportFailure(
          error,
          {
            operation: "slack.interaction.settle",
            component: "triggers",
            provider: "slack",
          },
          { scrubValues: [options.signingSecret] },
        );
      });
    }
    return new Response("OK", { status: 200 });
  } catch (error) {
    if (error instanceof SlackEventIntakeValidationError) {
      reportRejection("invalid_interaction", 400, options.signingSecret);
      return new Response("Bad Request", { status: 400 });
    }
    reportFailure(
      error,
      {
        operation: "slack.interactivity.handoff",
        component: "triggers",
        provider: "slack",
        status: 503,
      },
      { status: 503, scrubValues: [options.signingSecret] },
    );
    return Response.json({ error: "event_handoff_unavailable" }, { status: 503 });
  }
}

function parseInteractionBody(body: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (text.trimStart().startsWith("{")) return JSON.parse(text) as unknown;
  const payload = new URLSearchParams(text).get("payload");
  if (payload === null) throw new Error("Slack interaction payload is missing");
  return JSON.parse(payload) as unknown;
}

function readType(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const type: unknown = Reflect.get(payload, "type");
  return typeof type === "string" ? type : undefined;
}

function reportRejection(
  reason: string,
  status: number,
  signingSecret: string,
  signature?: string,
): void {
  reportFailure(
    Object.assign(new Error("Slack interaction request rejected"), { code: reason }),
    { operation: "slack.interactivity.verify", component: "triggers", provider: "slack", status },
    {
      status,
      kind: status === 401 ? "authentication" : "validation",
      scrubValues: [signingSecret, ...(signature === undefined ? [] : [signature])],
    },
  );
}
