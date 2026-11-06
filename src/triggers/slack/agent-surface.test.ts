import assert from "node:assert/strict";
import { beforeEach, describe, it } from "vitest";
import type { OutputExecutionInput } from "../../execution-capabilities/outputs.js";
import {
  beginSlackAgentRun,
  bindSlackAgentClient,
  createSlackAgentExecutor,
  finishSlackAgentRun,
  noteSlackAgentSessionStopped,
  resetSlackAgentSurfaceForTests,
  setSlackAgentClockForTests,
  SlackAgentSurfaceError,
  slackAgentOutputAvailable,
  type SlackAgentRunTarget,
} from "./agent-surface.js";
import { outputContextForSlackAgentStep } from "./agent-block.js";
import type { SlackApiResult, SlackBotClient } from "./client.js";

const MINUTE = 60 * 1000;

describe("Slack agent surface", () => {
  beforeEach(() => {
    resetSlackAgentSurfaceForTests();
  });

  it("hides the tools until the launch carries a Slack agent block", () => {
    assert.equal(
      slackAgentOutputAvailable({
        provider: "slack",
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1.1",
      }),
      false,
    );
    assert.equal(slackAgentOutputAvailable(context({ display: "plan" }).outputContext), true);
    const run = {
      provider: "slack",
      organizationId: "org-1",
      slackAgent: { display: "plan" as const },
    };
    assert.deepEqual(outputContextForSlackAgentStep(run, undefined), {
      provider: "slack",
      organizationId: "org-1",
    });
    assert.deepEqual(outputContextForSlackAgentStep(run, { display: "timeline" }), {
      ...run,
      slackAgent: { display: "timeline" },
    });
  });

  it("rotates the stream at 9 minutes and renews processing after 50", async () => {
    let now = 1_000_000;
    setSlackAgentClockForTests(() => now);
    const { client, calls } = surfaceClient();
    const target = runTarget({ display: "plan", session_title: "Pedido" });
    assert.equal(await beginSlackAgentRun(client, target), "agent");
    await runTool(client, "slack.agent.stage", {
      id: "read",
      title: "Reading",
      status: "in_progress",
    });
    now += 9 * MINUTE;
    await runTool(client, "slack.agent.stage", {
      id: "read",
      title: "Reading",
      status: "complete",
    });
    const rotated = calls.filter((call) => call.method === "stop" || call.method === "start");
    assert.equal(rotated[0]?.method, "start");
    assert.equal(rotated[1]?.method, "stop");
    assert.equal(rotated[1]?.input.sessionStatus, "processing");
    assert.equal(rotated[2]?.method, "start");

    now += 50 * MINUTE + 1;
    const before = calls.filter((call) => call.method === "status").length;
    await runTool(client, "slack.agent.say", { text: "Still going." });
    const statuses = calls.filter((call) => call.method === "status");
    assert.equal(statuses.length, before + 1);
    assert.equal(statuses.at(-1)?.input.status, "processing");
    assert.equal(statuses.at(-1)?.input.title, undefined);
  });

  it("sends the channel recipient and omits it for a direct message", async () => {
    const channel = surfaceClient();
    await runTool(
      channel.client,
      "slack.agent.stage",
      { id: "read", title: "Reading", status: "pending" },
      context({ display: "timeline" }, "C1"),
    );
    const started = channel.calls.find((call) => call.method === "start");
    assert.equal(started?.input.recipientUserId, "U1");
    assert.equal(started?.input.recipientTeamId, "T1");
    assert.equal(started?.input.taskDisplayMode, "timeline");
    const chunks = started?.input.chunks ?? [];
    assert.equal(
      chunks.some((chunk) => chunk.type === "plan_update"),
      false,
    );
    assert.equal(
      chunks.some((chunk) => chunk.type === "task_update" && chunk.status === "pending"),
      true,
    );

    resetSlackAgentSurfaceForTests();
    const direct = surfaceClient();
    await runTool(
      direct.client,
      "slack.agent.stage",
      { id: "read", title: "Reading", status: "in_progress" },
      context({ display: "plan", plan_title: "A tratar" }, "D1"),
    );
    const directStart = direct.calls.find((call) => call.method === "start");
    assert.equal(directStart?.input.recipientUserId, undefined);
    assert.equal(directStart?.input.recipientTeamId, undefined);
    assert.equal(directStart?.input.taskDisplayMode, "plan");
    assert.equal(
      directStart?.input.chunks?.some(
        (chunk) => chunk.type === "plan_update" && chunk.title === "A tratar",
      ),
      true,
    );
  });

  it("returns a short error for a missing scope and retries a missing session rename", async () => {
    const missing = surfaceClient({ startError: "missing_scope" });
    await assert.rejects(
      () =>
        runTool(missing.client, "slack.agent.tool", {
          id: "calendar",
          title: "Checking the calendar",
          status: "in_progress",
        }),
      (error: unknown) => {
        assert.ok(error instanceof SlackAgentSurfaceError);
        assert.match(error.message, /missing_scope/u);
        return true;
      },
    );

    resetSlackAgentSurfaceForTests();
    const renamed = surfaceClient({ renameError: "session_not_found" });
    await runTool(renamed.client, "slack.agent.title", { title: "Pedido de hoje" });
    assert.deepEqual(
      renamed.calls.map((call) => call.method),
      ["rename", "status", "rename"],
    );
  });

  it("marks the open task as failed and tells the model when the person stopped", async () => {
    const failed = surfaceClient();
    await runTool(failed.client, "slack.agent.stage", {
      id: "read",
      title: "Reading",
      status: "in_progress",
    });
    await runTool(failed.client, "slack.agent.fail", { output: "The calendar was down." });
    const appended = failed.calls.filter((call) => call.method === "append");
    const task = appended.at(-1)?.input.chunks?.find((chunk) => chunk.type === "task_update");
    assert.equal(task?.type === "task_update" ? task.status : undefined, "error");
    assert.equal(lastCall(failed.calls, "stop")?.input.sessionStatus, "active");

    resetSlackAgentSurfaceForTests();
    const stopped = surfaceClient();
    bindSlackAgentClient(stopped.client);
    await runTool(stopped.client, "slack.agent.stage", {
      id: "read",
      title: "Reading",
      status: "in_progress",
    });
    await noteSlackAgentSessionStopped({ teamId: "T1", channelId: "C1", threadTs: "1.1" });
    assert.equal(
      stopped.calls.some((call) => call.method === "stop"),
      true,
    );
    await assert.rejects(
      () => runTool(stopped.client, "slack.agent.say", { text: "One more line." }),
      /The person stopped this Slack session/u,
    );
  });

  it("falls back when the session cannot be created", async () => {
    const { client } = surfaceClient({ statusError: "missing_scope" });
    const target = runTarget({ display: "plan" });
    assert.equal(await beginSlackAgentRun(client, target), "fallback");
    await assert.rejects(
      () => runTool(client, "slack.agent.say", { text: "Hello." }, context({ display: "plan" })),
      /Slack agent surface is not available/u,
    );
    await finishSlackAgentRun(client, target, "success");
    await assert.rejects(() => finishSlackAgentRun(client, target, "failure"));
  });

  it("puts the agent's choices on the card only when the agent sends them", async () => {
    const choices = [{ label: "Ship it", value: "ship", style: "primary" }, { label: "Revise" }];
    const finished = surfaceClient();
    const block = { display: "plan" as const, feedback: true };
    const target = runTarget(block);
    await beginSlackAgentRun(finished.client, target);
    await runTool(finished.client, "slack.agent.say", { text: "Plan." }, context(block));
    await runTool(
      finished.client,
      "slack.agent.finish",
      { session: "suspended", choices },
      context(block),
    );
    assert.deepEqual(feedbackActionIds(lastCall(finished.calls, "stop")), [
      "paseo_choice_0",
      "paseo_choice_1",
    ]);
    assert.deepEqual(feedbackValues(lastCall(finished.calls, "stop")), ["ship", "Revise"]);

    resetSlackAgentSurfaceForTests();
    const plain = surfaceClient();
    await beginSlackAgentRun(plain.client, target);
    await runTool(plain.client, "slack.agent.say", { text: "Plan." }, context(block));
    await runTool(plain.client, "slack.agent.finish", { session: "suspended" }, context(block));
    assert.equal(lastCall(plain.calls, "stop")?.input.blocks, undefined);

    resetSlackAgentSurfaceForTests();
    const closed = surfaceClient();
    await beginSlackAgentRun(closed.client, target);
    await runTool(closed.client, "slack.agent.say", { text: "Plan." }, context(block));
    await assert.rejects(
      () =>
        runTool(
          closed.client,
          "slack.agent.finish",
          { session: "closed", choices },
          context(block),
        ),
      /active or suspended/u,
    );

    resetSlackAgentSurfaceForTests();
    let now = 1_000_000;
    setSlackAgentClockForTests(() => now);
    const rotated = surfaceClient();
    await beginSlackAgentRun(rotated.client, target);
    await runTool(
      rotated.client,
      "slack.agent.stage",
      { id: "read", title: "Reading", status: "in_progress" },
      context(block),
    );
    now += 9 * MINUTE;
    await runTool(
      rotated.client,
      "slack.agent.stage",
      { id: "read", title: "Reading", status: "complete" },
      context(block),
    );
    const rotation = rotated.calls.find(
      (call) => call.method === "stop" && call.input.sessionStatus === "processing",
    );
    assert.equal(rotation?.input.blocks, undefined);

    resetSlackAgentSurfaceForTests();
    const failed = surfaceClient();
    await beginSlackAgentRun(failed.client, target);
    await runTool(
      failed.client,
      "slack.agent.stage",
      { id: "read", title: "Reading", status: "in_progress" },
      context(block),
    );
    await runTool(
      failed.client,
      "slack.agent.fail",
      { output: "The calendar was down." },
      context(block),
    );
    assert.equal(lastCall(failed.calls, "stop")?.input.sessionStatus, "active");
    assert.equal(lastCall(failed.calls, "stop")?.input.blocks, undefined);

    resetSlackAgentSurfaceForTests();
    const idle = surfaceClient();
    await beginSlackAgentRun(idle.client, target);
    await runTool(idle.client, "slack.agent.say", { text: "Plan." }, context(block));
    await finishSlackAgentRun(idle.client, target, "success");
    assert.equal(lastCall(idle.calls, "stop")?.input.sessionStatus, "active");
    assert.equal(lastCall(idle.calls, "stop")?.input.blocks, undefined);

    resetSlackAgentSurfaceForTests();
    const asked = surfaceClient();
    await beginSlackAgentRun(asked.client, target);
    await runTool(
      asked.client,
      "slack.agent.finish",
      { session: "active", choices },
      context(block),
    );
    assert.deepEqual(feedbackActionIds(lastCall(asked.calls, "message")), [
      "paseo_choice_0",
      "paseo_choice_1",
    ]);

    resetSlackAgentSurfaceForTests();
    const refused = surfaceClient();
    await beginSlackAgentRun(refused.client, runTarget({ display: "plan" }));
    await assert.rejects(
      () =>
        runTool(
          refused.client,
          "slack.agent.finish",
          { session: "suspended", choices },
          context({ display: "plan" }),
        ),
      /feedback turned off/u,
    );

    resetSlackAgentSurfaceForTests();
    const stopped = surfaceClient();
    bindSlackAgentClient(stopped.client);
    await beginSlackAgentRun(stopped.client, target);
    await runTool(stopped.client, "slack.agent.say", { text: "Plan." }, context(block));
    await noteSlackAgentSessionStopped({ teamId: "T1", channelId: "C1", threadTs: "1.1" });
    assert.equal(lastCall(stopped.calls, "stop")?.input.sessionStatus, "active");
    assert.equal(lastCall(stopped.calls, "stop")?.input.blocks, undefined);
  });
});

function runTarget(block: SlackAgentRunTarget["block"]): SlackAgentRunTarget {
  return {
    organizationId: "org-1",
    teamId: "T1",
    channelId: "C1",
    threadTs: "1.1",
    authorId: "U1",
    block,
  };
}

function context(
  block: SlackAgentRunTarget["block"],
  channelId = "C1",
): Pick<OutputExecutionInput, "outputContext" | "triggerContext"> {
  return {
    outputContext: {
      provider: "slack",
      organizationId: "org-1",
      teamId: "T1",
      channelId,
      threadTs: "1.1",
      slackAgent: block,
    },
    triggerContext: { event: { slack: { trigger_message: { author: { id: "U1" } } } } },
  };
}

async function runTool(
  client: SlackBotClient,
  type:
    | "slack.agent.stage"
    | "slack.agent.tool"
    | "slack.agent.say"
    | "slack.agent.finish"
    | "slack.agent.fail"
    | "slack.agent.title"
    | "slack.agent.prompts",
  args: Record<string, unknown>,
  launch: Pick<OutputExecutionInput, "outputContext" | "triggerContext"> = context({
    display: "plan",
  }),
): Promise<void> {
  await createSlackAgentExecutor(
    client,
    type,
  )({
    agentExecutionId: "exec-1",
    toolType: type,
    args,
    outputContext: launch.outputContext,
    triggerContext: launch.triggerContext,
  });
}

function lastCall(
  calls: readonly RecordedCall[],
  method: RecordedCall["method"],
): RecordedCall | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call?.method === method) return call;
  }
  return undefined;
}

interface RecordedCall {
  method: "status" | "rename" | "start" | "append" | "stop" | "prompts" | "message";
  input: {
    status?: string;
    title?: string;
    sessionStatus?: string;
    blocks?: readonly Record<string, unknown>[];
    taskDisplayMode?: string;
    recipientUserId?: string;
    recipientTeamId?: string;
    chunks?: Array<{ type: string; title?: string; status?: string; id?: string }>;
  };
}

function feedbackActionIds(call: RecordedCall | undefined): string[] {
  return feedbackFields(call, "action_id");
}

function feedbackValues(call: RecordedCall | undefined): string[] {
  return feedbackFields(call, "value");
}

function feedbackFields(call: RecordedCall | undefined, key: string): string[] {
  const block = call?.input.blocks?.[0];
  const elements = isRecord(block) ? block["elements"] : undefined;
  if (!isList(elements)) return [];
  const fields: string[] = [];
  for (const element of elements) {
    const field = stringField(element, key);
    if (field !== undefined) fields.push(field);
  }
  return fields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function surfaceClient(
  options: {
    statusError?: string;
    startError?: string;
    renameError?: string;
  } = {},
): { client: SlackBotClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let stream = 0;
  let renamed = false;
  const ok = (error: string | undefined, once = false): SlackApiResult => {
    if (error === undefined) return { ok: true, ts: `1.${String(stream)}` };
    if (once && renamed) return { ok: true };
    return { ok: false, error };
  };
  const client: SlackBotClient = {
    sendMessage: (input) => {
      calls.push({ method: "message", input });
      return Promise.resolve();
    },
    addReaction: () => Promise.resolve(),
    removeReaction: () => Promise.resolve(),
    setAgentSessionStatus: (input) => {
      calls.push({ method: "status", input });
      return Promise.resolve(ok(options.statusError));
    },
    renameAgentSession: (input) => {
      calls.push({ method: "rename", input });
      const result = ok(renamed ? undefined : options.renameError);
      renamed = true;
      return Promise.resolve(result);
    },
    startAgentStream: (input) => {
      stream += 1;
      calls.push({ method: "start", input });
      return Promise.resolve({ ...ok(options.startError), ts: `1.${String(stream)}` });
    },
    appendAgentStream: (input) => {
      calls.push({ method: "append", input });
      return Promise.resolve({ ok: true });
    },
    stopAgentStream: (input) => {
      calls.push({ method: "stop", input });
      return Promise.resolve({ ok: true });
    },
    setSuggestedPrompts: (input) => {
      calls.push({ method: "prompts", input });
      return Promise.resolve({ ok: true });
    },
  };
  return { client, calls };
}
