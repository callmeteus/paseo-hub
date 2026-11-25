import { z } from "zod";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type { CompiledTriggerConfig } from "../../config/index.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentDescriptor,
} from "../../attachments/capabilities.js";
import { reportFailure } from "../../failures/index.js";
import { agentFailureNotice, missingBillingUrl } from "../failure-notice.js";
import {
  type ExternalTrigger,
  type TriggerProvider,
  type TriggerProviderMatch,
  type TriggerProviderResult,
} from "../index.js";
import { openingSlackAgentBlock, type SlackAgentBlock } from "./agent-block.js";
import {
  beginSlackAgentRun,
  finishSlackAgentRun,
  slackAgentRunFellBack,
  slackAgentTargetFromOpenBook,
  type SlackAgentRunTarget,
} from "./agent-surface.js";
import type { SlackBotClient, SlackThreadMessage } from "./client.js";
import {
  NormalizedSlackMentionEventSchema,
  SLACK_THREAD_SIGNAL_SOURCE,
  type NormalizedSlackMentionEvent,
} from "./events.js";
import { expandStoredSlackForwards } from "./forwarded-message.js";
import {
  matchSlackTriggers,
  readSlackInvocationParserMessage,
  readSlackPromptBody,
} from "./match.js";
import { defaultInputs, matchesInputFilters, parseInvocation } from "../invocation.js";

const ReplyGuardContextSchema = z.object({
  event: z.object({
    slack: z.object({
      trigger_message: z.object({
        ts: z.string().min(1),
        channel: z.object({ id: z.string().min(1) }),
        thread: z.object({ ts: z.string().min(1) }).optional(),
      }),
      team: z.object({ id: z.string().min(1) }),
    }),
  }),
});

const SlackThreadSignalSchema = z
  .object({
    type: z.literal("message"),
    channelId: z.string().min(1),
    channelType: z.enum(["channel", "group", "im", "mpim"]).optional(),
    threadTs: z.string().regex(/^\d+\.\d+$/u),
    messageTs: z.string().regex(/^\d+\.\d+$/u),
    text: z.string(),
    authorId: z.string().min(1),
    botId: z.string().optional(),
    subtype: z.string().optional(),
    fromBot: z.boolean().optional(),
  })
  .strict();

export interface SlackAttachmentLocator {
  id: string;
  filename: string;
  content_type: string | null;
  size: number | null;
}

interface SlackThreadContextLocator {
  status: "deferred";
  channel: { id: string };
  thread: { ts: string };
  before: { ts: string };
}

export interface SlackMergeData {
  slack: {
    event_type: "app_mention" | "message";
    event_id: string;
    event_ts: string;
    event_time: number;
    connection_id: string | null;
    team: { id: string };
    app: { id: string };
    /** Slack user of the bot that received the event. This bot executes the automation. */
    bot: { id: string };
    trigger_message: {
      ts: string;
      content: string;
      body: string;
      author: { id: string; username?: string | undefined };
      channel: { id: string };
      thread: { ts: string } | null;
      created_at: string;
      attachments: SlackAttachmentLocator[];
    };
    trigger_thread_context:
      | SlackThreadContextLocator
      | {
          status: "not_applicable";
        };
    /** Present when this event is an app-agent thread, not a channel post. */
    assistant_thread?: true;
    /** Present when the person wrote in a one-to-one direct message. */
    direct_message?: true;
  };
}

interface SlackMergeMessage {
  ts: string;
  content: string;
  author: { id: string };
  channel: { id: string };
  created_at: string;
  attachments: AttachmentDescriptor[];
}

interface SlackContextPayload {
  status: "available" | "incomplete" | "unavailable" | "not_applicable";
  messages: SlackMergeMessage[];
}

export interface SlackMaterializedContext {
  slack: {
    thread: SlackContextPayload;
    /** The message that opened this run, so a prompt can name who asked. */
    trigger_message: {
      ts: string;
      thread: { ts: string } | null;
      text: string;
      author: { id: string; name?: string | undefined };
    };
    event_type: SlackMergeData["slack"]["event_type"];
    /** Present when the person wrote in a one-to-one direct message. */
    direct_message?: true;
  };
}

export interface SlackTriggerContext {
  provider: "slack";
  target: SlackOutputContext;
  event: SlackMergeData;
}

export interface SlackOutputContext {
  provider: "slack";
  organizationId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  /** Locale of the trigger's system messages. Absent reads as English. */
  locale?: string;
  /** Copied from the first agent step that opted in. Absent when the run keeps the legacy status. */
  slackAgent?: SlackAgentBlock;
}

export function createSlackTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  botUserIdForWorkspace(organizationId: string, teamId: string): Promise<string | undefined>;
  client: SlackBotClient;
  attachments?: AttachmentCapabilityRegistry;
  billingUrlForOrganization?: (organizationId: string) => Promise<string>;
}): TriggerProvider<"slack", SlackTriggerContext, SlackOutputContext, SlackMaterializedContext> {
  async function readRepliesAfterMessage(
    launch: {
      executionId: string;
      organizationId: string;
      providerEventReceiptId: string;
      triggerContext: SlackTriggerContext;
    },
    message: SlackMergeData["slack"]["trigger_message"],
  ): Promise<{
    status: SlackMaterializedContext["slack"]["thread"]["status"];
    messages: SlackMaterializedContext["slack"]["thread"]["messages"];
  }> {
    if (options.client.readThreadMessages === undefined) {
      return { status: "available", messages: [] };
    }
    let history;
    try {
      history = await options.client.readThreadMessages({
        organizationId: launch.organizationId,
        teamId: launch.triggerContext.event.slack.team.id,
        channelId: message.channel.id,
        threadTs: message.ts,
        beforeTs: message.ts,
        afterTs: message.ts,
      });
    } catch (error) {
      reportFailure(
        error,
        { operation: "slack.thread.hydrate", component: "triggers", provider: "slack" },
        {
          diagnostic: {
            teamId: launch.triggerContext.event.slack.team.id,
            channelId: message.channel.id,
          },
        },
      );
      return { status: "available", messages: [] };
    }
    const messages = await Promise.all(
      history.messages
        .filter((item) => item.ts !== message.ts)
        .map(async (item) => ({
          ts: item.ts,
          content: item.content,
          author: item.author,
          channel: message.channel,
          created_at: item.createdAt,
          attachments: await registerAttachments(
            item.attachments,
            launch.providerEventReceiptId,
            launch.organizationId,
            launch.triggerContext.event.slack.team.id,
            launch.triggerContext.event.slack.connection_id,
            launch.executionId,
            options.attachments,
          ),
        })),
    );
    return { status: history.complete ? "available" : "incomplete", messages };
  }

  /**
   * A reply or edit in a thread is not a case. Only triggers that opted in to
   * interrupting a conversation can act on it, and their whole filter set is
   * still evaluated against the signal's text, author and channel.
   */
  async function matchThreadSignal(
    signalEvent: ExternalTrigger,
  ): Promise<TriggerProviderResult<SlackTriggerContext, SlackOutputContext>> {
    const signal = SlackThreadSignalSchema.parse(signalEvent.payload);
    const teamId = signalEvent.resourceId ?? "unknown";
    const botUserId = await options.botUserIdForWorkspace(signalEvent.organizationId, teamId);
    if (botUserId === undefined) return "configuration_unavailable";
    const stored = await options
      .configurationStoreForProject(signalEvent.projectId)
      .getRevision(signalEvent.configurationRevisionId);
    if (stored === undefined) return "configuration_unavailable";
    const event: NormalizedSlackMentionEvent = {
      type: "message",
      id: signalEvent.deliveryId,
      teamId,
      appId: teamId,
      channelId: signal.channelId,
      messageTs: signal.messageTs,
      threadTs: signal.threadTs,
      eventTs: signal.messageTs,
      eventTime: Math.floor(signalEvent.receivedAt.getTime() / 1_000),
      content: signal.text,
      channelType: signal.channelType,
      author: { id: signal.authorId },
      fromBot: signal.fromBot,
      lead: "",
      forwards: [],
      createdAt: signalEvent.receivedAt.toISOString(),
      attachments: [],
    };
    const matched = matchSlackTriggers(
      stored.configuration,
      event,
      botUserId,
      signalEvent.connectionId,
      SLACK_THREAD_SIGNAL_SOURCE,
    ).filter((match) => match.trigger.filters?.interrupt_active_thread_execution === true);
    if (matched.length === 0) return "trigger_filters_rejected";
    const outputContext: SlackOutputContext = {
      provider: "slack",
      organizationId: signalEvent.organizationId,
      teamId,
      channelId: signal.channelId,
      threadTs: signal.threadTs,
      messageTs: signal.messageTs,
    };
    return matched.map((match) => ({
      triggerName: match.trigger.name,
      triggerContext: {
        provider: "slack",
        target: outputContext,
        event: buildSlackMergeData(event, botUserId, signalEvent.connectionId),
      },
      outputContext,
      configurationRevisionId: signalEvent.configurationRevisionId,
      hubConfig: stored.configuration,
      conversation: {
        key: JSON.stringify(["slack", teamId, signal.channelId, signal.threadTs]),
        label: "Slack thread",
      },
      invocation: { status: "accepted", prompt: signal.text, inputs: {} },
      interruptOnly: true,
    }));
  }

  return {
    name: "slack",
    eventNames: ["slack.mention", "slack.message", SLACK_THREAD_SIGNAL_SOURCE],
    async match(trigger) {
      if (trigger.source === SLACK_THREAD_SIGNAL_SOURCE) {
        return matchThreadSignal(trigger);
      }
      const rawEvent = await includeReadableForwards(
        NormalizedSlackMentionEventSchema.parse(trigger.payload),
        trigger.organizationId,
        options.client,
      );
      const botUserId = await options.botUserIdForWorkspace(
        trigger.organizationId,
        rawEvent.teamId,
      );
      if (botUserId === undefined) return "configuration_unavailable";
      const stored = await options
        .configurationStoreForProject(trigger.projectId)
        .getRevision(trigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (!stored.configuration.triggers.some((candidate) => candidate.on === trigger.source))
        return "no_trigger_for_source";
      const event = needsSlackUsername(stored.configuration.triggers, rawEvent.author.id)
        ? await enrichSlackAuthor(rawEvent, trigger.organizationId, options.client)
        : rawEvent;
      const matchedTriggers = matchSlackTriggers(
        stored.configuration,
        event,
        botUserId,
        trigger.connectionId,
      );
      if (matchedTriggers.length === 0) return "trigger_filters_rejected";
      const matches: TriggerProviderMatch<SlackTriggerContext, SlackOutputContext>[] = [];

      for (const match of matchedTriggers) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiledTrigger === undefined)
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
        const slackAgent = openingSlackAgentBlock(compiledTrigger.steps);
        const outputContext: SlackOutputContext = {
          provider: "slack",
          organizationId: trigger.organizationId,
          teamId: rawEvent.teamId,
          channelId: rawEvent.channelId,
          threadTs: rawEvent.threadTs ?? rawEvent.messageTs,
          messageTs: rawEvent.messageTs,
          ...(compiledTrigger.locale === undefined ? {} : { locale: compiledTrigger.locale }),
          ...(slackAgent === undefined ? {} : { slackAgent }),
        };
        const triggerContext: SlackTriggerContext = {
          provider: "slack",
          target: outputContext,
          event: buildSlackMergeData(event, botUserId, trigger.connectionId),
        };
        const invocation =
          rawEvent.planDecision === undefined
            ? parseInvocation(
                rawEvent.content,
                compiledTrigger.inputs,
                undefined,
                readSlackInvocationParserMessage(rawEvent, botUserId, compiledTrigger.filters),
              )
            : {
                status: "accepted" as const,
                prompt: rawEvent.content,
                inputs: defaultInputs(compiledTrigger.inputs),
              };
        if (rawEvent.planDecision === undefined && invocation.status === "accepted") {
          if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
        }
        if (invocation.status === "rejected") {
          matches.push({
            conversation: slackConversation(rawEvent),
            triggerName: match.trigger.name,
            triggerContext,
            outputContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          });
          continue;
        }
        matches.push({
          conversation: slackConversation(rawEvent),
          triggerName: match.trigger.name,
          triggerContext,
          outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
          invocation,
        });
      }
      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },
    async materializeContext(launch): Promise<SlackMaterializedContext> {
      const event = launch.triggerContext.event.slack;
      const locator = event.trigger_thread_context;
      if (locator.status === "not_applicable") {
        // A channel message has no earlier thread. Show the message that started it,
        // plus replies that arrived after it. A later step, such as one that waits
        // before acting, has to see those replies.
        const message = event.trigger_message;
        const root = {
          ts: message.ts,
          content: message.content,
          author: message.author,
          channel: message.channel,
          created_at: message.created_at,
          attachments: await registerAttachments(
            message.attachments.map((file) => ({
              id: file.id,
              filename: file.filename,
              contentType: file.content_type,
              size: file.size,
            })),
            launch.providerEventReceiptId,
            launch.organizationId,
            event.team.id,
            event.connection_id,
            launch.executionId,
            options.attachments,
          ),
        };
        const later = await readRepliesAfterMessage(launch, message);
        return {
          slack: {
            thread: {
              status: later.status,
              messages: [root, ...later.messages],
            },
            ...triggerMessageContext(event),
          },
        };
      }
      if (options.client.readThreadMessages === undefined) {
        return {
          slack: {
            thread: { status: "unavailable", messages: [] },
            ...triggerMessageContext(event),
          },
        };
      }
      let history;
      try {
        history = await options.client.readThreadMessages({
          organizationId: launch.organizationId,
          teamId: launch.triggerContext.event.slack.team.id,
          channelId: locator.channel.id,
          threadTs: locator.thread.ts,
          beforeTs: locator.before.ts,
        });
      } catch (error) {
        reportFailure(
          error,
          { operation: "slack.thread.hydrate", component: "triggers", provider: "slack" },
          {
            diagnostic: {
              teamId: launch.triggerContext.event.slack.team.id,
              channelId: locator.channel.id,
            },
          },
        );
        return {
          slack: {
            thread: { status: "unavailable", messages: [] },
            ...triggerMessageContext(event),
          },
        };
      }
      const messages = await Promise.all(
        history.messages.map(async (message) => ({
          ts: message.ts,
          content: message.content,
          author: message.author,
          channel: { id: locator.channel.id },
          created_at: message.createdAt,
          attachments: await registerAttachments(
            message.attachments,
            launch.providerEventReceiptId,
            launch.organizationId,
            event.team.id,
            event.connection_id,
            launch.executionId,
            options.attachments,
          ),
        })),
      );
      return {
        slack: {
          thread: {
            status: history.complete ? "available" : "incomplete",
            messages,
          },
          ...triggerMessageContext(event),
        },
      };
    },
    async onAgentExecutionStarted(context, outputContext) {
      try {
        await applyLifecycleReactions(options.client, context, outputContext, "start");
      } catch (error) {
        reportFailure(
          error,
          { operation: "slack.reaction.start", component: "triggers", provider: "slack" },
          { diagnostic: { teamId: context.target.teamId, channelId: context.target.channelId } },
        );
      }
      const target = slackAgentTarget(context, outputContext);
      if (target === undefined) {
        await publishAssistantStatus(options.client, context, ASSISTANT_RUNNING_STATUS);
        return;
      }
      try {
        const outcome = await beginSlackAgentRun(options.client, target);
        if (outcome === "fallback") {
          await publishAssistantStatus(options.client, context, ASSISTANT_RUNNING_STATUS);
        }
      } catch (error) {
        reportFailure(
          error,
          { operation: "slack.agent.session.start", component: "triggers", provider: "slack" },
          { diagnostic: { teamId: context.target.teamId, channelId: context.target.channelId } },
        );
      }
    },
    async onAgentExecutionCompleted(context, outputContext) {
      await applyBoundaryReactions(options.client, context, outputContext, "finish");
      await finishSlackAgentLifecycle(options.client, context, outputContext, "success");
    },
    async onAgentExecutionFailed(context, outputContext, reason) {
      await applyBoundaryReactions(options.client, context, outputContext, "failure");
      await finishSlackAgentLifecycle(options.client, context, outputContext, "failure");
      if (
        reason === "stopped_by_user" ||
        reason === "agent_interrupted" ||
        missingAgentSession(reason)
      )
        return null;
      await failWithNotice(
        options.client,
        context.target,
        await agentFailureNotice(
          reason,
          context.target.organizationId,
          options.billingUrlForOrganization ?? missingBillingUrl,
          { locale: context.target.locale },
        ),
      );
      return null;
    },
    async checkReplyGuard({ execution }) {
      const guard = execution.launchIntent?.replyGuard;
      if (guard === undefined) return { matched: false };
      const parsed = ReplyGuardContextSchema.safeParse(execution.triggerContext);
      if (!parsed.success) return { matched: false };
      const context = parsed.data;
      const message = context.event.slack.trigger_message;
      const threadTs = message.thread?.ts ?? message.ts;
      const afterTs = message.ts;
      const beforeTs = `${Math.floor(Date.now() / 1000) + 60}.000000`;
      if (options.client.readThreadMessages === undefined) return { matched: false };
      let history;
      try {
        history = await options.client.readThreadMessages({
          organizationId: execution.organizationId,
          teamId: context.event.slack.team.id,
          channelId: message.channel.id,
          threadTs,
          beforeTs,
          afterTs,
        });
      } catch {
        return { matched: false };
      }
      const expression = guard.matchesRegex.replace(/^\(\?i\)/u, "");
      const pattern = new RegExp(expression, "iu");
      return {
        matched: history.messages.some((item) => item.ts !== afterTs && pattern.test(item.content)),
      };
    },
    async onMachineTerminated(context, reason, reactionState) {
      await applyBoundaryReactions(options.client, context, context.target, "failure");
      await finishSlackAgentLifecycle(options.client, context, context.target, "failure");
      if (reason === "launch_failed" || reason === "daemon_disconnected") {
        await failWithNotice(
          options.client,
          context.target,
          await agentFailureNotice(
            reason,
            context.target.organizationId,
            options.billingUrlForOrganization ?? missingBillingUrl,
            { locale: context.target.locale },
          ),
        );
        return null;
      }
      return reactionState;
    },
  };
}

/**
 * The part of the context that describes the message that opened this run.
 *
 * The hydrated thread stops before that message, so a prompt reading only the thread
 * cannot tell who asked. Everything here comes from the stored event: no Slack call.
 *
 * @param event - Slack merge data stored on the run
 * @returns The trigger message, the event type, and the direct-message flag
 */
function triggerMessageContext(
  event: SlackMergeData["slack"],
): Omit<SlackMaterializedContext["slack"], "thread"> {
  return {
    trigger_message: {
      ts: event.trigger_message.ts,
      thread: event.trigger_message.thread,
      text: event.trigger_message.content,
      author: {
        id: event.trigger_message.author.id,
        ...(event.trigger_message.author.username === undefined
          ? {}
          : { name: event.trigger_message.author.username }),
      },
    },
    event_type: event.event_type,
    ...(event.direct_message === true ? { direct_message: true as const } : {}),
  };
}

/**
 * Replaces a forward with the source message when the bot can read that channel.
 *
 * A private conversation returns nothing. The unfurl already stored on the event stays.
 *
 * @param event - Normalized Slack event
 * @param organizationId - Hub organization that owns the Slack connection
 * @param client - Slack client for the workspace
 * @returns The event, with source text and files when a forward could be opened
 */
async function includeReadableForwards(
  event: NormalizedSlackMentionEvent,
  organizationId: string,
  client: SlackBotClient,
): Promise<NormalizedSlackMentionEvent> {
  if (event.forwards.length === 0 || client.readSharedMessage === undefined) {
    return event;
  }

  const expanded = await expandStoredSlackForwards(event, (locator) => {
    if (client.readSharedMessage === undefined) {
      return Promise.resolve(undefined);
    }

    return client.readSharedMessage({
      organizationId,
      teamId: event.teamId,
      channelId: locator.channelId,
      messageTs: locator.messageTs,
    });
  });

  return {
    ...event,
    content: expanded.content,
    attachments: expanded.files.map((file) => ({
      id: file.id,
      filename: file.name ?? file.title ?? file.id,
      contentType: file.mimetype ?? null,
      size: file.size ?? null,
    })),
  };
}

async function enrichSlackAuthor(
  event: NormalizedSlackMentionEvent,
  organizationId: string,
  client: SlackBotClient,
): Promise<NormalizedSlackMentionEvent> {
  if (client.lookupUserName === undefined) return event;
  try {
    const username = await client.lookupUserName({
      organizationId,
      teamId: event.teamId,
      userId: event.author.id,
    });
    return username === undefined ? event : { ...event, author: { ...event.author, username } };
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.user.lookup", component: "triggers", provider: "slack" },
      { diagnostic: { teamId: event.teamId, userId: event.author.id } },
    );
    return event;
  }
}

function needsSlackUsername(
  triggers: readonly Pick<CompiledTriggerConfig, "on" | "filters">[],
  authorId: string,
): boolean {
  return triggers.some(
    (candidate) =>
      (candidate.on === "slack.mention" || candidate.on === "slack.message") &&
      candidate.filters?.from_users !== undefined &&
      !candidate.filters.from_users.includes("*") &&
      !candidate.filters.from_users.includes(authorId),
  );
}

const ASSISTANT_RUNNING_STATUS = "is thinking...";

function buildSlackMergeData(
  event: NormalizedSlackMentionEvent,
  botUserId: string,
  connectionId: string | null | undefined,
): SlackMergeData {
  const assistantThread = event.assistantThread === true;
  const threadTs = event.threadTs;
  // The event that opens the app-agent thread is the root. There is no earlier history.
  const openedAssistantThread =
    assistantThread && threadTs !== null && threadTs === event.messageTs;
  return {
    slack: {
      event_type: event.type === "message" ? "message" : "app_mention",
      event_id: event.id,
      event_ts: event.eventTs,
      event_time: event.eventTime,
      connection_id: connectionId ?? null,
      team: { id: event.teamId },
      app: { id: event.appId },
      bot: { id: botUserId },
      trigger_message: {
        ts: event.messageTs,
        content: event.content,
        body: readSlackPromptBody(event, botUserId),
        author: event.author,
        channel: { id: event.channelId },
        thread: threadTs === null ? null : { ts: threadTs },
        created_at: event.createdAt,
        attachments: event.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          content_type: attachment.contentType,
          size: attachment.size,
        })),
      },
      trigger_thread_context:
        threadTs === null || openedAssistantThread
          ? { status: "not_applicable" }
          : {
              status: "deferred",
              channel: { id: event.channelId },
              thread: { ts: threadTs },
              before: { ts: event.messageTs },
            },
      ...(assistantThread ? { assistant_thread: true as const } : {}),
      ...(event.channelType === "im" ? { direct_message: true as const } : {}),
    },
  };
}

/**
 * The continuation scope for this Slack arrival.
 *
 * A channel uses the thread, or the message that opened it. A direct message uses the
 * conversation itself, so the next line from that person continues the same agent.
 *
 * @param event - Normalized Slack event
 * @returns The conversation key and label stored on the match
 */
function slackConversation(event: NormalizedSlackMentionEvent): { key: string; label: string } {
  const scope = event.channelType === "im" ? event.channelId : (event.threadTs ?? event.messageTs);
  return {
    key: JSON.stringify(["slack", event.teamId, event.channelId, scope]),
    label: event.channelType === "im" ? "Slack direct message" : "Slack thread",
  };
}

/**
 * Sets the app-agent status for this run, then lets the reply use `chat.postMessage`.
 *
 * A token without `assistant:write` is logged by the client and does not block the reply.
 * Status on any other Slack event is left alone.
 *
 * @param client - The workspace bot
 * @param context - Trigger context stored on the run
 * @param status - Short status, or an empty string to clear it
 */
function slackAgentTarget(
  context: SlackTriggerContext,
  outputContext: SlackOutputContext | undefined,
): SlackAgentRunTarget | undefined {
  const source = outputContext?.slackAgent !== undefined ? outputContext : context.target;
  if (source.slackAgent === undefined) return undefined;
  return {
    organizationId: source.organizationId,
    teamId: source.teamId,
    channelId: source.channelId,
    threadTs: source.threadTs,
    authorId: context.event.slack.trigger_message.author.id,
    block: source.slackAgent,
  };
}

/**
 * Closes the agent surface, or the legacy status when this run never opened one.
 *
 * A failure of the new path clears the legacy indicator so "Working..." cannot sit for an hour.
 */
/**
 * Applies the reactions a trigger configured for the execution boundaries.
 * The Hub does this itself so the model cannot forget it.
 *
 * @param client - Workspace bot
 * @param context - Trigger context with the arrival that opened the thread
 * @param outputContext - Output context carrying the configured block
 * @param phase - Which boundary is closing
 */
async function applyLifecycleReactions(
  client: SlackBotClient,
  context: SlackTriggerContext,
  outputContext: SlackOutputContext | undefined,
  phase: "start" | "finish" | "failure",
): Promise<void> {
  const block = outputContext?.slackAgent ?? context.target.slackAgent;
  const reactions = block?.lifecycle_reactions;
  let name: string | undefined;
  if (phase === "start") name = reactions?.on_start;
  else if (phase === "finish") name = reactions?.on_finish;
  else name = reactions?.on_failure;
  if (name === undefined) return;
  const message = context.event.slack.trigger_message;
  const timestamps = new Set([message.ts]);
  const threadTs = message.thread?.ts;
  if (threadTs !== undefined && threadTs !== message.ts) timestamps.add(threadTs);
  for (const messageTs of timestamps) {
    await client.addReaction({
      organizationId: context.target.organizationId,
      teamId: context.target.teamId,
      channelId: message.channel.id,
      messageTs,
      name,
    });
  }
}

async function applyBoundaryReactions(
  client: SlackBotClient,
  context: SlackTriggerContext,
  outputContext: SlackOutputContext | undefined,
  phase: "finish" | "failure",
): Promise<void> {
  try {
    await applyLifecycleReactions(client, context, outputContext, phase);
  } catch (error) {
    reportFailure(
      error,
      { operation: `slack.reaction.${phase}`, component: "triggers", provider: "slack" },
      { diagnostic: { teamId: context.target.teamId, channelId: context.target.channelId } },
    );
  }
}

async function finishSlackAgentLifecycle(
  client: SlackBotClient,
  context: SlackTriggerContext,
  outputContext: SlackOutputContext | undefined,
  kind: "success" | "failure",
): Promise<void> {
  const target =
    slackAgentTarget(context, outputContext) ??
    slackAgentTargetFromOpenBook({
      organizationId: context.target.organizationId,
      teamId: context.target.teamId,
      channelId: context.target.channelId,
      threadTs: context.target.threadTs,
    });
  if (target === undefined || slackAgentRunFellBack(target)) {
    await publishAssistantStatus(client, context, "");
    return;
  }
  try {
    await finishSlackAgentRun(client, target, kind);
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.agent.session.finish", component: "triggers", provider: "slack" },
      { diagnostic: { teamId: target.teamId, channelId: target.channelId } },
    );
    if (kind === "failure") await publishAssistantStatus(client, context, "");
  }
}

function missingAgentSession(reason: string): boolean {
  return /session/i.test(reason) && /not found/i.test(reason);
}

async function publishAssistantStatus(
  client: SlackBotClient,
  context: SlackTriggerContext,
  status: string,
): Promise<void> {
  if (context.event.slack.assistant_thread !== true) return;
  if (client.setAssistantStatus === undefined) return;
  try {
    await client.setAssistantStatus({
      organizationId: context.target.organizationId,
      teamId: context.target.teamId,
      channelId: context.target.channelId,
      threadTs: context.target.threadTs,
      status,
    });
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.assistant.status", component: "triggers", provider: "slack" },
      { diagnostic: { teamId: context.target.teamId, channelId: context.target.channelId } },
    );
  }
}

async function registerAttachments(
  source: SlackThreadMessage["attachments"],
  providerEventReceiptId: string,
  organizationId: string,
  teamId: string,
  connectionId: string | null,
  executionId: string,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<AttachmentDescriptor[]> {
  if (source.length === 0) return [];
  if (attachments === undefined) throw new Error("attachment capability unavailable");
  if (connectionId === null) {
    throw new Error("attachment ownership unavailable");
  }
  const references = await Promise.all(
    source.map((file) =>
      attachments.register({
        providerEventReceiptId,
        organizationId,
        connectionId,
        provider: "slack",
        sourceId: file.id,
        locator: { teamId, fileId: file.id },
        filename: file.filename,
        contentType: file.contentType,
        byteSize: file.size,
      }),
    ),
  );
  return references.map((reference) => attachments.materialize(reference, executionId));
}

async function failWithNotice(
  client: SlackBotClient,
  event: SlackOutputContext,
  reason: string,
): Promise<void> {
  await client.sendMessage({
    organizationId: event.organizationId,
    teamId: event.teamId,
    channelId: event.channelId,
    threadTs: event.threadTs,
    content: reason,
  });
}
