import { z } from "zod";
import type { OutputExecutor, OutputToolDefinition } from "../../execution-capabilities/outputs.js";
import { reportFailure } from "../../failures/index.js";
import { logger } from "../../logger.js";
import {
  SlackAgentBlockSchema,
  type SlackAgentBlock,
  type SlackAgentOutputType,
} from "./agent-block.js";
import type {
  SlackAgentSessionStatus,
  SlackApiResult,
  SlackBotClient,
  SlackStreamChunk,
  SlackStreamSource,
  SlackStreamTaskStatus,
} from "./client.js";

const STREAM_ROTATE_AFTER_MS = 9 * 60 * 1000;
const PROCESSING_RENEW_AFTER_MS = 50 * 60 * 1000;

const RUN_FALLBACK_ERRORS = new Set(["missing_scope", "feature_disabled", "not_authorized"]);
const TOOL_SOFT_ERRORS = new Set(["missing_scope", "feature_disabled", "not_agent_app"]);
const CLOSED_STREAM_ERRORS = new Set(["stopped_by_user", "message_not_in_streaming_state"]);

const HttpsUrlSchema = z.string().refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "Source URL must use https.");

const TaskIdSchema = z.string().min(1);
const TaskTitleSchema = z.string().min(1);
const StageArgsSchema = z
  .object({
    id: TaskIdSchema,
    title: TaskTitleSchema,
    status: z.enum(["pending", "in_progress", "complete"]),
    details: z.string().optional(),
    output: z.string().optional(),
    plan_title: z.string().min(1).optional(),
  })
  .strict();
const ToolArgsSchema = z
  .object({
    id: TaskIdSchema,
    title: TaskTitleSchema,
    status: z.enum(["in_progress", "complete", "error"]),
    details: z.string().optional(),
    output: z.string().optional(),
    sources: z
      .array(
        z
          .object({
            text: z.string().min(1),
            url: HttpsUrlSchema,
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();
const SayArgsSchema = z.object({ text: z.string().min(1) }).strict();
const FinishArgsSchema = z
  .object({
    session: z.enum(["active", "suspended", "closed"]),
    text: z.string().min(1).optional(),
  })
  .strict();
const FailArgsSchema = z
  .object({
    id: TaskIdSchema.optional(),
    title: TaskTitleSchema.optional(),
    output: z.string().optional(),
    session: z.enum(["active", "suspended"]).optional(),
  })
  .strict();
const TitleArgsSchema = z.object({ title: z.string().min(1).max(200) }).strict();
const PromptItemSchema = z
  .object({
    title: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
const PromptsArgsSchema = z
  .object({
    title: z.string().min(1).optional(),
    items: z.array(PromptItemSchema).min(1).max(4),
  })
  .strict();

const ToolContextSchema = z.object({
  provider: z.literal("slack"),
  organizationId: z.string().min(1),
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  slackAgent: SlackAgentBlockSchema,
});

/**
 * A Slack answer the model can recover from. The capability server returns this text as the
 * tool error, and the run keeps going so the model can still call `reply`.
 */
export class SlackAgentSurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackAgentSurfaceError";
  }
}

export interface SlackAgentRunTarget {
  organizationId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  authorId?: string | undefined;
  block: SlackAgentBlock;
}

interface SlackAgentApi {
  setAgentSessionStatus: NonNullable<SlackBotClient["setAgentSessionStatus"]>;
  renameAgentSession: NonNullable<SlackBotClient["renameAgentSession"]>;
  startAgentStream: NonNullable<SlackBotClient["startAgentStream"]>;
  appendAgentStream: NonNullable<SlackBotClient["appendAgentStream"]>;
  stopAgentStream: NonNullable<SlackBotClient["stopAgentStream"]>;
  setSuggestedPrompts: NonNullable<SlackBotClient["setSuggestedPrompts"]>;
}

interface TaskState {
  id: string;
  title: string;
  status: SlackStreamTaskStatus;
  details?: string | undefined;
  output?: string | undefined;
  sources?: SlackStreamSource[] | undefined;
}

interface ThreadBook {
  key: string;
  organizationId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  authorId: string | undefined;
  fallback: boolean;
  processingAt: number | undefined;
  heldSession: SlackAgentSessionStatus | undefined;
  agentClosed: boolean;
}

interface ExecutionStream {
  executionId: string;
  threadKey: string;
  display: "plan" | "timeline";
  planTitle: string | undefined;
  ts: string | undefined;
  openedAt: number | undefined;
  tasks: Map<string, TaskState>;
}

const threads = new Map<string, ThreadBook>();
const streams = new Map<string, ExecutionStream>();
const stoppedThreads = new Set<string>();
let boundClient: SlackBotClient | undefined;
let clock: () => number = () => Date.now();

/**
 * Remembers the bot the intake path uses when Slack says the person stopped the session.
 *
 * @param client - Workspace bot created with the Slack registration
 */
export function bindSlackAgentClient(client: SlackBotClient): void {
  boundClient = client;
}

/** Clears the in-memory books. Tests call this so one case cannot see another case's stream. */
export function resetSlackAgentSurfaceForTests(): void {
  threads.clear();
  streams.clear();
  stoppedThreads.clear();
  boundClient = undefined;
  clock = () => Date.now();
}

/**
 * Replaces the clock used for the 9-minute stream rotation and the 50-minute session renewal.
 *
 * @param now - Milliseconds since the epoch
 */
export function setSlackAgentClockForTests(now: () => number): void {
  clock = now;
}

/**
 * Opens the agent session for a run that opted in.
 *
 * A missing scope, a disabled agent-tasks feature, or `not_authorized` marks the thread as
 * fallback. The caller then shows the legacy assistant status. Any other failure is reported
 * and the tools may still try the stream.
 *
 * @param client - Workspace bot
 * @param target - Channel, thread, and the block copied onto the run
 * @returns Whether the legacy status should take over
 */
export async function beginSlackAgentRun(
  client: SlackBotClient,
  target: SlackAgentRunTarget,
): Promise<"agent" | "fallback"> {
  const book = bookFor(target);
  if (book.fallback) return "fallback";
  const api = agentApi(client);
  if (api === undefined) {
    book.fallback = true;
    return "fallback";
  }
  let result: SlackApiResult;
  try {
    result = await api.setAgentSessionStatus({
      organizationId: target.organizationId,
      teamId: target.teamId,
      channelId: target.channelId,
      threadTs: target.threadTs,
      status: "processing",
      ...(target.block.session_title === undefined ? {} : { title: target.block.session_title }),
    });
  } catch (error) {
    reportSlackFailure(error, "slack.agent.session.start", target);
    return "agent";
  }
  if (!result.ok) {
    if (result.error !== undefined && RUN_FALLBACK_ERRORS.has(result.error)) {
      book.fallback = true;
      return "fallback";
    }
    reportSlackFailure(
      new Error(`Slack API ${result.error ?? "unknown_error"}`),
      "slack.agent.session.start",
      target,
    );
    return "agent";
  }
  book.processingAt = clock();
  await sendConfiguredPrompts(api, target);
  return "agent";
}

/**
 * Whether the opening session call fell back to the legacy assistant status.
 *
 * @param target - Channel and thread of the run
 * @returns True when the new surface must not clear or replace that legacy status
 */
export function slackAgentRunFellBack(target: SlackAgentRunTarget): boolean {
  return threads.get(threadKey(target))?.fallback === true;
}

/**
 * Closes the surface at the end of the run.
 *
 * Success leaves a session the model parked as `suspended` or `closed` alone. Failure marks
 * an in-progress task as `error` and returns the session to `active`. A failure here is thrown
 * so the caller can clear the legacy indicator when the new call could not.
 *
 * @param client - Workspace bot
 * @param target - Channel and thread of the run
 * @param kind - Whether the run succeeded or the work stopped with an error
 */
export async function finishSlackAgentRun(
  client: SlackBotClient,
  target: SlackAgentRunTarget,
  kind: "success" | "failure",
): Promise<void> {
  const book = threads.get(threadKey(target));
  if (book?.fallback === true) {
    if (kind === "failure") throw new Error("Slack agent surface is unavailable");
    return;
  }
  const api = requireApi(client);
  const open = streamsFor(target);
  if (kind === "success" && book?.agentClosed === true) {
    await finishHeldSession(api, target, open, book);
    return;
  }
  if (kind === "failure") {
    await finishFailedSession(api, target, open, book);
    return;
  }
  await closeOpenStreams(api, target, open, "active");
  forgetStreams(target);
}

/** Leaves a session the model already parked, and closes a stream that is still open. */
async function finishHeldSession(
  api: SlackAgentApi,
  target: SlackAgentRunTarget,
  open: readonly ExecutionStream[],
  book: ThreadBook,
): Promise<void> {
  const session =
    book.heldSession === "suspended" || book.heldSession === "closed" ? book.heldSession : "active";
  for (const stream of open) {
    if (stream.ts === undefined) continue;
    await closeStream(api, target, stream, session);
  }
  forgetStreams(target);
}

/** Marks in-progress tasks as failed and returns the session to active. */
async function finishFailedSession(
  api: SlackAgentApi,
  target: SlackAgentRunTarget,
  open: readonly ExecutionStream[],
  book: ThreadBook | undefined,
): Promise<void> {
  for (const stream of open) await markInProgressFailed(api, target, stream);
  await closeOpenStreams(api, target, open, "active");
  if (book !== undefined) {
    book.heldSession = "active";
    book.agentClosed = true;
  }
  forgetStreams(target);
}

/**
 * Closes every open stream with the given session, or sets the session when none is streaming.
 *
 * @returns Nothing
 */
async function closeOpenStreams(
  api: SlackAgentApi,
  target: SlackAgentRunTarget,
  open: readonly ExecutionStream[],
  session: SlackAgentSessionStatus,
): Promise<void> {
  let closed = false;
  for (const stream of open) {
    if (stream.ts === undefined) continue;
    await closeStream(api, target, stream, session);
    closed = true;
  }
  if (!closed) await setSession(api, target, session);
}

/**
 * Slack told us the person stopped the session. The Hub execution is not cancelled.
 *
 * Later surface tools on this thread tell the model the person stopped. A stream Slack has
 * already closed answers `stopped_by_user` or `message_not_in_streaming_state`, and that is
 * the normal end.
 *
 * @param input - Channel and thread from `agent_session_stopped`
 */
export async function noteSlackAgentSessionStopped(input: {
  teamId: string;
  channelId: string;
  threadTs: string;
}): Promise<void> {
  const key = threadKey(input);
  stoppedThreads.add(key);
  const book = threads.get(key);
  const client = boundClient;
  if (book === undefined || client === undefined) return;
  const api = agentApi(client);
  if (api === undefined) return;
  const target: SlackAgentRunTarget = {
    organizationId: book.organizationId,
    teamId: book.teamId,
    channelId: book.channelId,
    threadTs: book.threadTs,
    authorId: book.authorId,
    block: { display: "timeline" },
  };
  try {
    for (const stream of streams.values()) {
      if (stream.threadKey !== key || stream.ts === undefined) continue;
      const stopped = await api.stopAgentStream({
        organizationId: book.organizationId,
        teamId: book.teamId,
        channelId: book.channelId,
        streamTs: stream.ts,
        sessionStatus: "active",
      });
      stream.ts = undefined;
      if (!stopped.ok && !CLOSED_STREAM_ERRORS.has(stopped.error ?? "")) {
        logger.warn(
          { provider: "slack", operation: "slack.agent.session.stop", error: stopped.error },
          "Slack agent stream did not close after the person stopped the session",
        );
      }
    }
    const status = await api.setAgentSessionStatus({
      organizationId: book.organizationId,
      teamId: book.teamId,
      channelId: book.channelId,
      threadTs: book.threadTs,
      status: "active",
    });
    if (!status.ok) {
      logger.warn(
        { provider: "slack", operation: "slack.agent.session.stop", error: status.error },
        "Slack agent session stayed in its previous state after the person stopped it",
      );
    }
    book.heldSession = "active";
    book.agentClosed = true;
    forgetStreams(target);
  } catch (error) {
    reportSlackFailure(error, "slack.agent.session.stop", target);
  }
}

const objectSchema = {
  type: "object" as const,
  additionalProperties: false,
};

export const slackStageTool: OutputToolDefinition = {
  name: "slack_stage",
  description:
    "Shows one stage of the work in the Slack thread. Pass a stable id, a short title, and pending, in_progress, or complete. In a timeline, Slack hides a pending stage. Hub does not change that.",
  inputSchema: {
    ...objectSchema,
    properties: {
      id: { type: "string", minLength: 1, description: "Stable id for this stage." },
      title: { type: "string", minLength: 1, description: "Stage title people will read." },
      status: { type: "string", enum: ["pending", "in_progress", "complete"] },
      details: { type: "string", description: "Optional detail under the stage." },
      output: { type: "string", description: "Optional result text for the stage." },
      plan_title: {
        type: "string",
        minLength: 1,
        description: "When the display is a plan, replaces the plan title.",
      },
    },
    required: ["id", "title", "status"],
  },
};

export const slackToolTool: OutputToolDefinition = {
  name: "slack_tool",
  description:
    'Shows one action in the Slack thread, the way a tool call appears. The title is a sentence a person can read, such as "Checking the calendar", not a method name. Status is in_progress, complete, or error.',
  inputSchema: {
    ...objectSchema,
    properties: {
      id: { type: "string", minLength: 1, description: "Stable id for this action." },
      title: { type: "string", minLength: 1, description: "What is happening, in plain language." },
      status: { type: "string", enum: ["in_progress", "complete", "error"] },
      details: { type: "string" },
      output: { type: "string" },
      sources: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1 },
            url: { type: "string", minLength: 1 },
          },
          required: ["text", "url"],
        },
      },
    },
    required: ["id", "title", "status"],
  },
};

export const slackSayTool: OutputToolDefinition = {
  name: "slack_say",
  description: "Appends markdown to the Slack message that is streaming this run's work.",
  inputSchema: {
    ...objectSchema,
    properties: { text: { type: "string", minLength: 1 } },
    required: ["text"],
  },
};

export const slackFinishTool: OutputToolDefinition = {
  name: "slack_finish",
  description:
    "Stops the streaming Slack message and sets the session to active, suspended, or closed. Suspended waits for the person. Closed ends the session without archiving the channel.",
  inputSchema: {
    ...objectSchema,
    properties: {
      session: { type: "string", enum: ["active", "suspended", "closed"] },
      text: { type: "string", minLength: 1, description: "Optional final markdown." },
    },
    required: ["session"],
  },
};

export const slackFailTool: OutputToolDefinition = {
  name: "slack_fail",
  description:
    "Marks the current Slack task as failed and leaves the session active, or suspended when the person has to decide. Defaults to active.",
  inputSchema: {
    ...objectSchema,
    properties: {
      id: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      output: { type: "string" },
      session: { type: "string", enum: ["active", "suspended"] },
    },
    required: [],
  },
};

export const slackTitleTool: OutputToolDefinition = {
  name: "slack_title",
  description: "Renames the Slack thread in the header and the thread list.",
  inputSchema: {
    ...objectSchema,
    properties: { title: { type: "string", minLength: 1, maxLength: 200 } },
    required: ["title"],
  },
};

export const slackPromptsTool: OutputToolDefinition = {
  name: "slack_prompts",
  description:
    "Replaces the suggested prompts at the top of the Slack Messages tab. Send one to four prompts, each with a title and the message Slack will send if the person picks it.",
  inputSchema: {
    ...objectSchema,
    properties: {
      title: { type: "string", minLength: 1, description: "Optional title of the prompt list." },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1 },
            message: { type: "string", minLength: 1 },
          },
          required: ["title", "message"],
        },
      },
    },
    required: ["items"],
  },
};

const TOOLS: Record<SlackAgentOutputType, OutputToolDefinition> = {
  "slack.agent.stage": slackStageTool,
  "slack.agent.tool": slackToolTool,
  "slack.agent.say": slackSayTool,
  "slack.agent.finish": slackFinishTool,
  "slack.agent.fail": slackFailTool,
  "slack.agent.title": slackTitleTool,
  "slack.agent.prompts": slackPromptsTool,
};

/**
 * The tool definition for one surface output.
 *
 * @param type - Output type granted on the step
 * @returns The tool the model calls
 */
export function slackAgentTool(type: SlackAgentOutputType): OutputToolDefinition {
  return TOOLS[type];
}

/**
 * True when this launch opted into the Slack agent surface.
 *
 * @param outputContext - Output context on the launch
 * @returns Whether the seven tools should be offered
 */
export function slackAgentOutputAvailable(outputContext: unknown): boolean {
  return ToolContextSchema.safeParse(outputContext).success;
}

/**
 * Runs one surface tool against the Slack thread stored on the launch.
 *
 * @param client - Workspace bot
 * @param type - Which surface tool this call is
 * @returns The executor registered for that output
 */
export function createSlackAgentExecutor(
  client: SlackBotClient,
  type: SlackAgentOutputType,
): OutputExecutor {
  return async function executeSlackAgent(input) {
    const context = ToolContextSchema.parse(input.outputContext);
    const target: SlackAgentRunTarget = {
      organizationId: context.organizationId,
      teamId: context.teamId,
      channelId: context.channelId,
      threadTs: context.threadTs,
      authorId: readAuthorId(input.triggerContext),
      block: context.slackAgent,
    };
    const book = assertRunnable(target);
    const api = requireApi(client);
    if (type === "slack.agent.stage") {
      await publishStage(
        api,
        book,
        target,
        input.agentExecutionId,
        StageArgsSchema.parse(input.args),
      );
      return;
    }
    if (type === "slack.agent.tool") {
      await publishTool(
        api,
        book,
        target,
        input.agentExecutionId,
        ToolArgsSchema.parse(input.args),
      );
      return;
    }
    if (type === "slack.agent.say") {
      await publishSay(api, book, target, input.agentExecutionId, SayArgsSchema.parse(input.args));
      return;
    }
    if (type === "slack.agent.finish") {
      await publishFinish(
        api,
        book,
        target,
        input.agentExecutionId,
        FinishArgsSchema.parse(input.args),
      );
      return;
    }
    if (type === "slack.agent.fail") {
      await publishFail(
        api,
        book,
        target,
        input.agentExecutionId,
        FailArgsSchema.parse(input.args),
      );
      return;
    }
    if (type === "slack.agent.title") {
      await publishTitle(api, target, TitleArgsSchema.parse(input.args));
      return;
    }
    await publishPrompts(api, target, PromptsArgsSchema.parse(input.args));
  };
}

async function publishStage(
  api: SlackAgentApi,
  book: ThreadBook,
  target: SlackAgentRunTarget,
  executionId: string,
  args: z.infer<typeof StageArgsSchema>,
): Promise<void> {
  const stream = executionStream(executionId, target);
  if (args.plan_title !== undefined && stream.display === "plan")
    stream.planTitle = args.plan_title;
  const task = rememberTask(stream, {
    id: args.id,
    title: args.title,
    status: args.status,
    details: args.details,
    output: args.output,
  });
  const chunks: SlackStreamChunk[] = [];
  if (args.plan_title !== undefined && stream.display === "plan") {
    chunks.push({ type: "plan_update", title: args.plan_title });
  }
  chunks.push(taskChunk(task));
  await deliver(api, book, target, stream, chunks);
}

async function publishTool(
  api: SlackAgentApi,
  book: ThreadBook,
  target: SlackAgentRunTarget,
  executionId: string,
  args: z.infer<typeof ToolArgsSchema>,
): Promise<void> {
  const stream = executionStream(executionId, target);
  const sources = args.sources?.map((source) => ({
    type: "url" as const,
    text: source.text,
    url: source.url,
  }));
  const task = rememberTask(stream, {
    id: args.id,
    title: args.title,
    status: args.status,
    details: args.details,
    output: args.output,
    sources,
  });
  await deliver(api, book, target, stream, [taskChunk(task)]);
}

async function publishSay(
  api: SlackAgentApi,
  book: ThreadBook,
  target: SlackAgentRunTarget,
  executionId: string,
  args: z.infer<typeof SayArgsSchema>,
): Promise<void> {
  const stream = executionStream(executionId, target);
  await deliver(api, book, target, stream, [{ type: "markdown_text", text: args.text }]);
}

async function publishFinish(
  api: SlackAgentApi,
  book: ThreadBook,
  target: SlackAgentRunTarget,
  executionId: string,
  args: z.infer<typeof FinishArgsSchema>,
): Promise<void> {
  const stream = streams.get(executionId);
  await closeModelStream(api, book, target, stream, args.session, args.text);
}

async function publishFail(
  api: SlackAgentApi,
  book: ThreadBook,
  target: SlackAgentRunTarget,
  executionId: string,
  args: z.infer<typeof FailArgsSchema>,
): Promise<void> {
  const stream = executionStream(executionId, target);
  const session = args.session ?? "active";
  const failing = tasksToFail(stream, args.id);
  if (failing.length > 0 || args.id !== undefined) {
    const subjects = failing.length > 0 ? failing : [fallbackFailure(stream, args)];
    const chunks = subjects.map((task) => {
      task.status = "error";
      if (args.output !== undefined) task.output = args.output;
      if (args.title !== undefined) task.title = args.title;
      return taskChunk(task);
    });
    await deliver(api, book, target, stream, chunks);
  }
  await closeModelStream(api, book, target, stream, session, undefined);
}

async function publishTitle(
  api: SlackAgentApi,
  target: SlackAgentRunTarget,
  args: z.infer<typeof TitleArgsSchema>,
): Promise<void> {
  const renamed = await api.renameAgentSession({
    organizationId: target.organizationId,
    teamId: target.teamId,
    channelId: target.channelId,
    threadTs: target.threadTs,
    title: args.title,
  });
  if (renamed.ok) return;
  if (renamed.error !== "session_not_found") refuseOrThrow(renamed);
  const created = await api.setAgentSessionStatus({
    organizationId: target.organizationId,
    teamId: target.teamId,
    channelId: target.channelId,
    threadTs: target.threadTs,
    status: "processing",
  });
  refuseOrThrow(created);
  const book = threads.get(threadKey(target));
  if (book !== undefined) book.processingAt = clock();
  refuseOrThrow(
    await api.renameAgentSession({
      organizationId: target.organizationId,
      teamId: target.teamId,
      channelId: target.channelId,
      threadTs: target.threadTs,
      title: args.title,
    }),
  );
}

async function publishPrompts(
  api: SlackAgentApi,
  target: SlackAgentRunTarget,
  args: z.infer<typeof PromptsArgsSchema>,
): Promise<void> {
  refuseOrThrow(
    await api.setSuggestedPrompts({
      organizationId: target.organizationId,
      teamId: target.teamId,
      channelId: target.channelId,
      prompts: args.items,
      ...(args.title === undefined ? {} : { title: args.title }),
    }),
  );
}

async function closeModelStream(
  api: SlackAgentApi,
  book: ThreadBook,
  target: SlackAgentRunTarget,
  stream: ExecutionStream | undefined,
  session: SlackAgentSessionStatus,
  text: string | undefined,
): Promise<void> {
  if (stream?.ts !== undefined) {
    const chunks: SlackStreamChunk[] = text === undefined ? [] : [{ type: "markdown_text", text }];
    const stopped = await api.stopAgentStream({
      organizationId: target.organizationId,
      teamId: target.teamId,
      channelId: target.channelId,
      streamTs: stream.ts,
      ...(chunks.length === 0 ? {} : { chunks }),
      sessionStatus: session,
    });
    stream.ts = undefined;
    if (!stopped.ok && stopped.error === "stopped_by_user") {
      stoppedThreads.add(book.key);
      throw new SlackAgentSurfaceError("The person stopped this Slack session.");
    }
    if (!stopped.ok && stopped.error !== "message_not_in_streaming_state") refuseOrThrow(stopped);
  } else {
    await setSession(api, target, session);
  }
  book.heldSession = session;
  book.agentClosed = true;
}

async function deliver(
  api: SlackAgentApi,
  book: ThreadBook,
  target: SlackAgentRunTarget,
  stream: ExecutionStream,
  chunks: SlackStreamChunk[],
): Promise<void> {
  await renewProcessing(api, book, target);
  const expired =
    stream.ts !== undefined &&
    stream.openedAt !== undefined &&
    clock() - stream.openedAt >= STREAM_ROTATE_AFTER_MS;
  if (expired) await closeStream(api, target, stream, "processing");
  if (stream.ts === undefined) {
    const started = await api.startAgentStream({
      organizationId: target.organizationId,
      teamId: target.teamId,
      channelId: target.channelId,
      threadTs: target.threadTs,
      taskDisplayMode: stream.display,
      chunks: openingChunks(stream, chunks),
      ...recipients(target, book),
    });
    refuseOrThrow(started);
    if (started.ts === undefined) throw new Error("Slack API stream timestamp missing");
    stream.ts = started.ts;
    stream.openedAt = clock();
    return;
  }
  refuseOrThrow(
    await api.appendAgentStream({
      organizationId: target.organizationId,
      teamId: target.teamId,
      channelId: target.channelId,
      streamTs: stream.ts,
      chunks,
    }),
  );
}

/**
 * A new stream does not keep the tasks from the message Slack just closed.
 * Resend the ones that are still running, then the chunks for this call.
 */
function openingChunks(
  stream: ExecutionStream,
  delta: readonly SlackStreamChunk[],
): SlackStreamChunk[] {
  const chunks: SlackStreamChunk[] = [];
  if (stream.display === "plan" && stream.planTitle !== undefined) {
    chunks.push({ type: "plan_update", title: stream.planTitle });
  }
  const replaced = new Set(
    delta.flatMap((chunk) => (chunk.type === "task_update" ? [chunk.id] : [])),
  );
  for (const task of stream.tasks.values()) {
    if (task.status === "complete" || task.status === "error") continue;
    if (replaced.has(task.id)) continue;
    chunks.push(taskChunk(task));
  }
  chunks.push(...delta);
  return chunks;
}

async function renewProcessing(
  api: SlackAgentApi,
  book: ThreadBook,
  target: SlackAgentRunTarget,
): Promise<void> {
  if (book.processingAt !== undefined && clock() - book.processingAt <= PROCESSING_RENEW_AFTER_MS) {
    return;
  }
  const renewed = await api.setAgentSessionStatus({
    organizationId: target.organizationId,
    teamId: target.teamId,
    channelId: target.channelId,
    threadTs: target.threadTs,
    status: "processing",
  });
  refuseOrThrow(renewed);
  book.processingAt = clock();
}

async function closeStream(
  api: SlackAgentApi,
  target: SlackAgentRunTarget,
  stream: ExecutionStream,
  session: SlackAgentSessionStatus,
): Promise<void> {
  if (stream.ts === undefined) return;
  const stopped = await api.stopAgentStream({
    organizationId: target.organizationId,
    teamId: target.teamId,
    channelId: target.channelId,
    streamTs: stream.ts,
    sessionStatus: session,
  });
  stream.ts = undefined;
  if (stopped.ok || stopped.error === "message_not_in_streaming_state") return;
  if (stopped.error === "stopped_by_user") {
    stoppedThreads.add(threadKey(target));
    throw new SlackAgentSurfaceError("The person stopped this Slack session.");
  }
  refuseOrThrow(stopped);
}

async function markInProgressFailed(
  api: SlackAgentApi,
  target: SlackAgentRunTarget,
  stream: ExecutionStream,
): Promise<void> {
  const failing = [...stream.tasks.values()].filter((task) => task.status === "in_progress");
  if (failing.length === 0) return;
  for (const task of failing) task.status = "error";
  if (stream.ts === undefined) return;
  const marked = await api.appendAgentStream({
    organizationId: target.organizationId,
    teamId: target.teamId,
    channelId: target.channelId,
    streamTs: stream.ts,
    chunks: failing.map((task) => taskChunk(task)),
  });
  if (marked.ok || CLOSED_STREAM_ERRORS.has(marked.error ?? "")) return;
  refuseOrThrow(marked);
}

async function setSession(
  api: SlackAgentApi,
  target: SlackAgentRunTarget,
  status: SlackAgentSessionStatus,
): Promise<void> {
  refuseOrThrow(
    await api.setAgentSessionStatus({
      organizationId: target.organizationId,
      teamId: target.teamId,
      channelId: target.channelId,
      threadTs: target.threadTs,
      status,
    }),
  );
}

async function sendConfiguredPrompts(
  api: SlackAgentApi,
  target: SlackAgentRunTarget,
): Promise<void> {
  const prompts = target.block.prompts;
  if (prompts === undefined) return;
  try {
    const result = await api.setSuggestedPrompts({
      organizationId: target.organizationId,
      teamId: target.teamId,
      channelId: target.channelId,
      prompts: prompts.items,
      ...(prompts.title === undefined ? {} : { title: prompts.title }),
    });
    if (result.ok) return;
    logger.warn(
      {
        provider: "slack",
        operation: "slack.agent.prompts",
        teamId: target.teamId,
        channelId: target.channelId,
        error: result.error,
      },
      "Slack suggested prompts were not updated",
    );
  } catch (error) {
    reportSlackFailure(error, "slack.agent.prompts", target);
  }
}

function tasksToFail(stream: ExecutionStream, id: string | undefined): TaskState[] {
  if (id !== undefined) {
    const named = stream.tasks.get(id);
    return named === undefined ? [] : [named];
  }
  return [...stream.tasks.values()].filter((task) => task.status === "in_progress");
}

function fallbackFailure(stream: ExecutionStream, args: z.infer<typeof FailArgsSchema>): TaskState {
  const task: TaskState = {
    id: args.id ?? "failed",
    title: args.title ?? "Failed",
    status: "error",
    ...(args.output === undefined ? {} : { output: args.output }),
  };
  stream.tasks.set(task.id, task);
  return task;
}

function rememberTask(
  stream: ExecutionStream,
  next: {
    id: string;
    title: string;
    status: SlackStreamTaskStatus;
    details?: string | undefined;
    output?: string | undefined;
    sources?: SlackStreamSource[] | undefined;
  },
): TaskState {
  const current = stream.tasks.get(next.id);
  const task: TaskState = {
    id: next.id,
    title: next.title,
    status: next.status,
    details: next.details ?? current?.details,
    output: next.output ?? current?.output,
    sources: next.sources ?? current?.sources,
  };
  stream.tasks.set(task.id, task);
  return task;
}

function taskChunk(task: TaskState): SlackStreamChunk {
  return {
    type: "task_update",
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.details === undefined ? {} : { details: task.details }),
    ...(task.output === undefined ? {} : { output: task.output }),
    ...(task.sources === undefined ? {} : { sources: task.sources }),
  };
}

function executionStream(executionId: string, target: SlackAgentRunTarget): ExecutionStream {
  const existing = streams.get(executionId);
  if (existing !== undefined) return existing;
  const created: ExecutionStream = {
    executionId,
    threadKey: threadKey(target),
    display: target.block.display,
    planTitle: target.block.display === "plan" ? target.block.plan_title : undefined,
    ts: undefined,
    openedAt: undefined,
    tasks: new Map(),
  };
  streams.set(executionId, created);
  return created;
}

function streamsFor(target: SlackAgentRunTarget): ExecutionStream[] {
  const key = threadKey(target);
  return [...streams.values()].filter((stream) => stream.threadKey === key);
}

function forgetStreams(target: SlackAgentRunTarget): void {
  const key = threadKey(target);
  for (const [executionId, stream] of streams) {
    if (stream.threadKey === key) streams.delete(executionId);
  }
}

function assertRunnable(target: SlackAgentRunTarget): ThreadBook {
  const key = threadKey(target);
  if (stoppedThreads.has(key)) {
    throw new SlackAgentSurfaceError("The person stopped this Slack session.");
  }
  const book = bookFor(target);
  if (book.fallback) {
    throw new SlackAgentSurfaceError("Slack agent surface is not available.");
  }
  return book;
}

function bookFor(target: SlackAgentRunTarget): ThreadBook {
  const key = threadKey(target);
  const existing = threads.get(key);
  if (existing !== undefined) {
    if (target.authorId !== undefined) existing.authorId = target.authorId;
    return existing;
  }
  const created: ThreadBook = {
    key,
    organizationId: target.organizationId,
    teamId: target.teamId,
    channelId: target.channelId,
    threadTs: target.threadTs,
    authorId: target.authorId,
    fallback: false,
    processingAt: undefined,
    heldSession: undefined,
    agentClosed: false,
  };
  threads.set(key, created);
  return created;
}

function recipients(
  target: SlackAgentRunTarget,
  book: ThreadBook,
): { recipientUserId?: string; recipientTeamId?: string } {
  if (target.channelId.startsWith("D")) return {};
  const userId = target.authorId ?? book.authorId;
  if (userId === undefined) return {};
  return { recipientUserId: userId, recipientTeamId: target.teamId };
}

function threadKey(input: { teamId: string; channelId: string; threadTs: string }): string {
  return `${input.teamId}\0${input.channelId}\0${input.threadTs}`;
}

function requireApi(client: SlackBotClient): SlackAgentApi {
  const api = agentApi(client);
  if (api === undefined) {
    throw new SlackAgentSurfaceError("Slack agent surface is not available.");
  }
  return api;
}

function agentApi(client: SlackBotClient): SlackAgentApi | undefined {
  if (
    client.setAgentSessionStatus === undefined ||
    client.renameAgentSession === undefined ||
    client.startAgentStream === undefined ||
    client.appendAgentStream === undefined ||
    client.stopAgentStream === undefined ||
    client.setSuggestedPrompts === undefined
  ) {
    return undefined;
  }
  return {
    setAgentSessionStatus: client.setAgentSessionStatus.bind(client),
    renameAgentSession: client.renameAgentSession.bind(client),
    startAgentStream: client.startAgentStream.bind(client),
    appendAgentStream: client.appendAgentStream.bind(client),
    stopAgentStream: client.stopAgentStream.bind(client),
    setSuggestedPrompts: client.setSuggestedPrompts.bind(client),
  };
}

function refuseOrThrow(result: SlackApiResult): void {
  if (result.ok) return;
  if (result.error !== undefined && TOOL_SOFT_ERRORS.has(result.error)) {
    throw new SlackAgentSurfaceError(`Slack agent surface is not available: ${result.error}.`);
  }
  throw new Error(`Slack API ${result.error ?? "unknown_error"}`);
}

function readAuthorId(triggerContext: unknown): string | undefined {
  if (!isRecord(triggerContext)) return undefined;
  const event = triggerContext["event"];
  if (!isRecord(event)) return undefined;
  const slack = event["slack"];
  if (!isRecord(slack)) return undefined;
  const message = slack["trigger_message"];
  if (!isRecord(message)) return undefined;
  const author = message["author"];
  if (!isRecord(author)) return undefined;
  const id = author["id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function reportSlackFailure(error: unknown, operation: string, target: SlackAgentRunTarget): void {
  reportFailure(
    error,
    { operation, component: "triggers", provider: "slack" },
    { diagnostic: { teamId: target.teamId, channelId: target.channelId } },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
