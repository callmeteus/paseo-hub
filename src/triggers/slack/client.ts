import { z } from "zod";
import { reportFailure } from "../../failures/index.js";
import { logger } from "../../logger.js";
import { readSlackMessageFiles, readSlackMessageText } from "./forwarded-message.js";

const SlackApiResponseSchema = z
  .object({ ok: z.boolean(), error: z.string().optional() })
  .passthrough();
const SlackApiResultSchema = SlackApiResponseSchema.extend({
  warning: z.string().optional(),
  channel: z.string().optional(),
  ts: z.string().optional(),
});
const SlackFileSchema = z
  .object({
    id: z.string().min(1).max(255),
    name: z.string().min(1).max(255).optional(),
    title: z.string().min(1).max(255).optional(),
    mimetype: z.string().min(1).max(255).optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .passthrough();
const SlackThreadMessageSchema = z
  .object({
    ts: z.string().regex(/^\d+\.\d+$/u),
    text: z.string().default(""),
    user: z.string().min(1).max(255).optional(),
    bot_id: z.string().min(1).max(255).optional(),
    files: z.array(SlackFileSchema).optional(),
  })
  .passthrough();
const SlackSharedMessageSchema = SlackApiResponseSchema.extend({
  messages: z.array(z.object({ ts: z.string() }).passthrough()).optional(),
});
const SlackThreadRepliesSchema = SlackApiResponseSchema.extend({
  messages: z.array(SlackThreadMessageSchema).optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});
const SlackFileInfoSchema = SlackApiResponseSchema.extend({
  file: z
    .object({
      id: z.string().min(1).max(255),
      url_private_download: z.url(),
    })
    .optional(),
});
const SlackUserInfoSchema = SlackApiResponseSchema.extend({
  user: z.object({ name: z.string().min(1).max(255) }).optional(),
});
const SlackChannelInfoSchema = SlackApiResponseSchema.extend({
  channel: z.object({ name: z.string().min(1).max(255).optional() }).optional(),
});
const SlackUserGroupListSchema = SlackApiResponseSchema.extend({
  usergroups: z
    .array(
      z.object({
        id: z.string().min(1).max(255),
        name: z.string().min(1).max(255).optional(),
      }),
    )
    .optional(),
});
const SLACK_API_TIMEOUT_MS = 10_000;
const SLACK_THREAD_REPLIES_MAX_PAGES = 10;
const SLACK_THREAD_CONTEXT_LIMIT = 50;

/** What Slack returned. `ok: false` stays a result; the caller decides which errors are fatal. */
export interface SlackApiResult {
  ok: boolean;
  error?: string | undefined;
  /** Present when Slack accepted the call and added a warning, such as a missing stop subscription. */
  warning?: string | undefined;
  channel?: string | undefined;
  ts?: string | undefined;
}

export type SlackAgentSessionStatus = "active" | "processing" | "suspended" | "closed";

export type SlackStreamTaskStatus = "pending" | "in_progress" | "complete" | "error";

export interface SlackStreamSource {
  type: "url";
  text: string;
  url: string;
}

/** One chunk of a Slack agent stream. The visible task card is `task_update`. */
export type SlackStreamChunk =
  | { type: "markdown_text"; text: string }
  | {
      type: "task_update";
      id: string;
      title: string;
      status: SlackStreamTaskStatus;
      details?: string;
      output?: string;
      sources?: SlackStreamSource[];
    }
  | { type: "plan_update"; title: string };

export interface SlackSuggestedPrompt {
  title: string;
  message: string;
}

export interface SlackAttachmentMetadata {
  id: string;
  filename: string;
  contentType: string | null;
  size: number | null;
}

export interface SlackThreadMessage {
  ts: string;
  createdAt: string;
  content: string;
  author: { id: string };
  attachments: SlackAttachmentMetadata[];
}

export interface SlackThreadReadResult {
  messages: SlackThreadMessage[];
  complete: boolean;
}

export interface SlackBotClient {
  sendMessage(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    content: string;
    /** Block Kit on the message. Choice buttons use this when no stream is open. */
    blocks?: readonly Record<string, unknown>[];
  }): Promise<void>;
  addReaction(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    name: string;
  }): Promise<void>;
  removeReaction(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    name: string;
  }): Promise<void>;
  readSharedMessage?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
  }): Promise<unknown>;
  readThreadMessages?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    beforeTs: string;
    /** When set, return replies newer than this timestamp instead of older than `beforeTs`. */
    afterTs?: string;
  }): Promise<SlackThreadReadResult>;
  lookupUserName?(input: {
    organizationId: string;
    teamId: string;
    userId: string;
  }): Promise<string | undefined>;
  lookupChannelName?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
  }): Promise<string | undefined>;
  listUserGroupNames?(input: {
    organizationId: string;
    teamId: string;
  }): Promise<ReadonlyMap<string, string>>;
  /**
   * Shows or clears the app-agent status in a thread.
   *
   * An empty `status` clears the indicator. `missing_scope` means the saved token
   * does not have `assistant:write` yet; the caller still posts with `chat.postMessage`.
   */
  setAssistantStatus?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    status: string;
  }): Promise<void>;
  /**
   * Sets the agent-session state. `title` is sent only when the caller is creating the session.
   * A warning such as `missing_agent_session_stopped_event_subscription` still counts as success.
   */
  setAgentSessionStatus?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    status: SlackAgentSessionStatus;
    title?: string;
  }): Promise<SlackApiResult>;
  /** Renames an agent session that `setAgentSessionStatus` or a stream already created. */
  renameAgentSession?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    title: string;
  }): Promise<SlackApiResult>;
  /**
   * Opens a streaming message. Channel posts (not a DM with the app) must include the recipient.
   * The returned `ts` is the message later calls append to.
   */
  startAgentStream?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    taskDisplayMode: "plan" | "timeline";
    chunks?: SlackStreamChunk[];
    recipientUserId?: string;
    recipientTeamId?: string;
  }): Promise<SlackApiResult>;
  /** Appends chunks to the message `startAgentStream` opened. */
  appendAgentStream?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    streamTs: string;
    chunks: SlackStreamChunk[];
  }): Promise<SlackApiResult>;
  /** Closes the streaming message. `sessionStatus` defaults to active on Slack's side when omitted. */
  stopAgentStream?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    streamTs: string;
    chunks?: SlackStreamChunk[];
    sessionStatus?: SlackAgentSessionStatus;
    /** Rendered under the finalized message. Choice buttons use this. */
    blocks?: readonly Record<string, unknown>[];
  }): Promise<SlackApiResult>;
  /** Replaces a message the app posted. `ok: false` is returned, not thrown. */
  updateMessage?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    text: string;
    blocks: readonly Record<string, unknown>[];
  }): Promise<SlackApiResult>;
  /**
   * Replaces the suggested prompts on the latest message in the channel.
   * An agent app ignores `thread_ts`, so this call never sends one.
   */
  setSuggestedPrompts?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    prompts: readonly SlackSuggestedPrompt[];
    title?: string;
  }): Promise<SlackApiResult>;
  downloadAttachment?(input: {
    organizationId: string;
    teamId: string;
    fileId: string;
  }): Promise<Response>;
}

export function createSlackBotClient(options: {
  tokenForWorkspace(organizationId: string, teamId: string): Promise<string | undefined>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}): SlackBotClient {
  const request = options.fetch ?? fetch;

  async function call(
    organizationId: string,
    teamId: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const token = await options.tokenForWorkspace(organizationId, teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const response = await request(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    const result = SlackApiResponseSchema.parse(await response.json());
    if (!result.ok) throw new Error(`Slack API ${result.error ?? "unknown_error"}`);
  }

  /**
   * Posts a JSON body that may contain arrays. The string-only `callJson` stays as it is.
   * Slack's `ok: false` is returned, not thrown, so the agent surface can tell a missing
   * scope from a dead stream.
   */
  async function postAgentJson(
    organizationId: string,
    teamId: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<SlackApiResult> {
    const token = await options.tokenForWorkspace(organizationId, teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const response = await request(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    const result = SlackApiResultSchema.parse(await response.json());
    return {
      ok: result.ok,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.warning === undefined ? {} : { warning: result.warning }),
      ...(result.channel === undefined ? {} : { channel: result.channel }),
      ...(result.ts === undefined ? {} : { ts: result.ts }),
    };
  }

  async function callJson(
    organizationId: string,
    teamId: string,
    method: string,
    body: Record<string, string>,
  ): Promise<unknown> {
    const token = await options.tokenForWorkspace(organizationId, teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const response = await request(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    return response.json();
  }

  /**
   * Slack rejects a JSON body on `files.info`, `users.info`, and `conversations.info`.
   * The same arguments as form fields succeed. `usergroups.list` still accepts JSON.
   */
  async function callForm(
    organizationId: string,
    teamId: string,
    method: string,
    body: Record<string, string>,
  ): Promise<unknown> {
    const token = await options.tokenForWorkspace(organizationId, teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const response = await request(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    return response.json();
  }

  async function queryJson(
    organizationId: string,
    teamId: string,
    method: string,
    query: Record<string, string>,
  ): Promise<unknown> {
    const token = await options.tokenForWorkspace(organizationId, teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const response = await request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    return response.json();
  }

  async function readSharedMessage(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
  }): Promise<unknown> {
    let result: z.infer<typeof SlackSharedMessageSchema>;

    try {
      result = SlackSharedMessageSchema.parse(
        await queryJson(input.organizationId, input.teamId, "conversations.history", {
          channel: input.channelId,
          latest: input.messageTs,
          oldest: input.messageTs,
          inclusive: "true",
          limit: "1",
        }),
      );
    } catch (error) {
      reportFailure(
        error,
        { operation: "slack.forward.read", component: "providers", provider: "slack" },
        { diagnostic: { teamId: input.teamId, channelId: input.channelId } },
      );
      return undefined;
    }

    // A private conversation the bot is not in, or a message Slack will not return.
    if (!result.ok) {
      return undefined;
    }

    return result.messages?.find((message) => message.ts === input.messageTs);
  }

  async function readThreadMessages(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    beforeTs: string;
    afterTs?: string;
  }): Promise<SlackThreadReadResult> {
    const afterTs = input.afterTs;
    let cursor: string | undefined;
    let root: SlackThreadMessage | undefined;
    let selectedReplies: SlackThreadMessage[] = [];
    const seenCursors = new Set<string>();
    let complete = true;
    let pagesRead = 0;
    while (true) {
      let result: z.infer<typeof SlackThreadRepliesSchema>;
      try {
        result = SlackThreadRepliesSchema.parse(
          await queryJson(input.organizationId, input.teamId, "conversations.replies", {
            channel: input.channelId,
            ts: input.threadTs,
            inclusive: "false",
            limit: "100",
            ...(afterTs === undefined ? { latest: input.beforeTs } : { oldest: afterTs }),
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        if (!result.ok) throw new Error(`Slack API ${result.error ?? "unknown_error"}`);
      } catch (error) {
        if (root === undefined && selectedReplies.length === 0) throw error;
        reportFailure(
          error,
          { operation: "slack.thread.history.page", component: "providers", provider: "slack" },
          { diagnostic: { teamId: input.teamId, channelId: input.channelId, pagesRead } },
        );
        complete = false;
        break;
      }
      const page = (result.messages ?? [])
        .map(normalizeThreadMessage)
        .filter((message) =>
          afterTs === undefined
            ? compareSlackTs(message.ts, input.beforeTs) < 0
            : compareSlackTs(message.ts, afterTs) > 0,
        );
      root ??= page.find((message) => message.ts === input.threadTs);
      selectedReplies = [
        ...selectedReplies,
        ...page.filter((message) => message.ts !== input.threadTs),
      ]
        .sort((left, right) => compareSlackTs(right.ts, left.ts))
        .slice(0, SLACK_THREAD_CONTEXT_LIMIT - 1);
      pagesRead += 1;
      const next = result.response_metadata?.next_cursor;
      cursor = next === undefined || next.length === 0 ? undefined : next;
      if (cursor === undefined) break;
      if (seenCursors.has(cursor)) {
        complete = false;
        break;
      }
      seenCursors.add(cursor);
      if (pagesRead === SLACK_THREAD_REPLIES_MAX_PAGES) {
        complete = false;
        break;
      }
    }

    const replies = selectedReplies.sort((left, right) => compareSlackTs(left.ts, right.ts));
    // A read of replies after the parent does not include the parent itself.
    if (root === undefined) {
      if (afterTs !== undefined) return { messages: replies, complete };
      throw new Error("Slack thread root unavailable");
    }
    return {
      messages: [root, ...replies],
      complete,
    };
  }

  async function downloadAttachment(input: {
    organizationId: string;
    teamId: string;
    fileId: string;
  }): Promise<Response> {
    const token = await options.tokenForWorkspace(input.organizationId, input.teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const result = SlackFileInfoSchema.parse(
      await callForm(input.organizationId, input.teamId, "files.info", { file: input.fileId }),
    );
    if (!result.ok || result.file?.id !== input.fileId) {
      throw new Error(`Slack file ${input.fileId} is unavailable`);
    }
    const downloadUrl = new URL(result.file.url_private_download);
    if (
      downloadUrl.protocol !== "https:" ||
      !["files.slack.com", "slack.com"].includes(downloadUrl.hostname)
    ) {
      throw new Error("Slack returned an invalid attachment URL");
    }
    return request(downloadUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
  }

  async function lookupUserName(input: {
    organizationId: string;
    teamId: string;
    userId: string;
  }): Promise<string | undefined> {
    const result = SlackUserInfoSchema.parse(
      await callForm(input.organizationId, input.teamId, "users.info", { user: input.userId }),
    );
    if (!result.ok) throw new Error(`Slack API ${result.error ?? "unknown_error"}`);
    return result.user?.name;
  }

  async function lookupChannelName(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
  }): Promise<string | undefined> {
    const result = SlackChannelInfoSchema.parse(
      await callForm(input.organizationId, input.teamId, "conversations.info", {
        channel: input.channelId,
      }),
    );
    if (!result.ok) throw new Error(`Slack API ${result.error ?? "unknown_error"}`);
    return result.channel?.name;
  }

  async function listUserGroupNames(input: {
    organizationId: string;
    teamId: string;
  }): Promise<ReadonlyMap<string, string>> {
    const result = SlackUserGroupListSchema.parse(
      await callJson(input.organizationId, input.teamId, "usergroups.list", {}),
    );
    if (!result.ok) throw new Error(`Slack API ${result.error ?? "unknown_error"}`);
    const names = new Map<string, string>();
    for (const group of result.usergroups ?? []) {
      if (group.name !== undefined) names.set(group.id, group.name);
    }
    return names;
  }

  async function setAssistantStatus(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    status: string;
  }): Promise<void> {
    const result = SlackApiResponseSchema.parse(
      await callJson(input.organizationId, input.teamId, "assistant.threads.setStatus", {
        channel_id: input.channelId,
        thread_ts: input.threadTs,
        status: input.status,
      }),
    );
    if (result.ok) return;
    if (result.error === "missing_scope") {
      logger.warn(
        {
          provider: "slack",
          operation: "slack.assistant.status",
          teamId: input.teamId,
          channelId: input.channelId,
        },
        "Slack token does not have assistant:write",
      );
      return;
    }
    throw new Error(`Slack API ${result.error ?? "unknown_error"}`);
  }

  async function setAgentSessionStatus(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    status: SlackAgentSessionStatus;
    title?: string;
  }): Promise<SlackApiResult> {
    return postAgentJson(
      input.organizationId,
      input.teamId,
      "agents.sessions.setStatus",
      definedBody({
        channel_id: input.channelId,
        thread_ts: input.threadTs,
        status: input.status,
        title: input.title,
      }),
    );
  }

  async function renameAgentSession(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    title: string;
  }): Promise<SlackApiResult> {
    return postAgentJson(input.organizationId, input.teamId, "agents.sessions.rename", {
      channel_id: input.channelId,
      thread_ts: input.threadTs,
      title: input.title,
    });
  }

  async function startAgentStream(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    taskDisplayMode: "plan" | "timeline";
    chunks?: SlackStreamChunk[];
    recipientUserId?: string;
    recipientTeamId?: string;
  }): Promise<SlackApiResult> {
    return postAgentJson(
      input.organizationId,
      input.teamId,
      "chat.startStream",
      definedBody({
        channel: input.channelId,
        thread_ts: input.threadTs,
        task_display_mode: input.taskDisplayMode,
        chunks: input.chunks,
        recipient_user_id: input.recipientUserId,
        recipient_team_id: input.recipientTeamId,
      }),
    );
  }

  async function appendAgentStream(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    streamTs: string;
    chunks: SlackStreamChunk[];
  }): Promise<SlackApiResult> {
    return postAgentJson(input.organizationId, input.teamId, "chat.appendStream", {
      channel: input.channelId,
      ts: input.streamTs,
      chunks: input.chunks,
    });
  }

  async function stopAgentStream(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    streamTs: string;
    chunks?: SlackStreamChunk[];
    sessionStatus?: SlackAgentSessionStatus;
    blocks?: readonly Record<string, unknown>[];
  }): Promise<SlackApiResult> {
    return postAgentJson(
      input.organizationId,
      input.teamId,
      "chat.stopStream",
      definedBody({
        channel: input.channelId,
        ts: input.streamTs,
        chunks: input.chunks,
        session_status: input.sessionStatus,
        blocks: input.blocks,
      }),
    );
  }

  async function updateMessage(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    text: string;
    blocks: readonly Record<string, unknown>[];
  }): Promise<SlackApiResult> {
    return postAgentJson(input.organizationId, input.teamId, "chat.update", {
      channel: input.channelId,
      ts: input.messageTs,
      text: input.text,
      blocks: input.blocks,
    });
  }

  async function setSuggestedPrompts(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    prompts: readonly SlackSuggestedPrompt[];
    title?: string;
  }): Promise<SlackApiResult> {
    return postAgentJson(
      input.organizationId,
      input.teamId,
      "assistant.threads.setSuggestedPrompts",
      definedBody({
        channel_id: input.channelId,
        prompts: input.prompts,
        title: input.title,
      }),
    );
  }

  return {
    sendMessage: (input) =>
      call(input.organizationId, input.teamId, "chat.postMessage", {
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: input.content,
        ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
      }),
    setAssistantStatus,
    setAgentSessionStatus,
    renameAgentSession,
    startAgentStream,
    appendAgentStream,
    stopAgentStream,
    updateMessage,
    setSuggestedPrompts,
    addReaction: (input) =>
      call(input.organizationId, input.teamId, "reactions.add", {
        channel: input.channelId,
        timestamp: input.messageTs,
        name: input.name,
      }),
    removeReaction: (input) =>
      call(input.organizationId, input.teamId, "reactions.remove", {
        channel: input.channelId,
        timestamp: input.messageTs,
        name: input.name,
      }),
    readThreadMessages,
    readSharedMessage,
    lookupUserName,
    lookupChannelName,
    listUserGroupNames,
    downloadAttachment,
  };
}

/**
 * The name lookups Home can ask of the bot the Hub already connected.
 *
 * A test double that never grew these methods answers with nothing, which leaves the stored
 * id on the row.
 */
export interface SlackNameDirectory {
  lookupUserName(input: {
    organizationId: string;
    teamId: string;
    userId: string;
  }): Promise<string | undefined>;
  lookupChannelName(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
  }): Promise<string | undefined>;
  listUserGroupNames(input: {
    organizationId: string;
    teamId: string;
  }): Promise<ReadonlyMap<string, string>>;
}

/**
 * Adapts the bot client Home already has. Missing methods stay empty rather than throwing,
 * so an older double does not take the review down.
 *
 * @param client - The workspace bot
 * @returns The three lookups the review uses
 */
export function slackNameDirectory(client: SlackBotClient): SlackNameDirectory {
  return {
    lookupUserName(input) {
      return client.lookupUserName?.(input) ?? Promise.resolve(undefined);
    },
    lookupChannelName(input) {
      return client.lookupChannelName?.(input) ?? Promise.resolve(undefined);
    },
    listUserGroupNames(input) {
      return client.listUserGroupNames?.(input) ?? Promise.resolve(new Map());
    },
  };
}

function normalizeThreadMessage(
  message: z.infer<typeof SlackThreadMessageSchema>,
): SlackThreadMessage {
  return {
    ts: message.ts,
    createdAt: new Date(Number(message.ts) * 1_000).toISOString(),
    content: readSlackMessageText(message),
    author: { id: message.user ?? message.bot_id ?? "unknown" },
    attachments: readSlackMessageFiles(message).map((file) => ({
      id: file.id,
      filename: file.name ?? file.title ?? file.id,
      contentType: file.mimetype ?? null,
      size: file.size ?? null,
    })),
  };
}

function compareSlackTs(left: string, right: string): number {
  return Number(left) - Number(right);
}

/** Drops omitted fields so a DM stream is not sent empty recipient ids. */
function definedBody(fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body[key] = value;
  }
  return body;
}
