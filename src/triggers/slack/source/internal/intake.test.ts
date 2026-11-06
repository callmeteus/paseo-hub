import assert from "node:assert/strict";
import { beforeEach, describe, it } from "vitest";
import {
  bindSlackAgentClient,
  createSlackAgentExecutor,
  resetSlackAgentSurfaceForTests,
} from "../../agent-surface.js";
import type { SlackBotClient } from "../../client.js";
import { intakeSlackEvent } from "./intake.js";

describe("Slack event intake", () => {
  beforeEach(() => {
    resetSlackAgentSurfaceForTests();
  });

  it("closes the agent stream when the person stops and does not open an automation", async () => {
    const calls: string[] = [];
    const client: SlackBotClient = {
      sendMessage: () => Promise.resolve(),
      addReaction: () => Promise.resolve(),
      removeReaction: () => Promise.resolve(),
      setAgentSessionStatus: () => {
        calls.push("status");
        return Promise.resolve({ ok: true });
      },
      renameAgentSession: () => Promise.resolve({ ok: true }),
      startAgentStream: () => {
        calls.push("start");
        return Promise.resolve({ ok: true, ts: "1.2" });
      },
      appendAgentStream: () => Promise.resolve({ ok: true }),
      stopAgentStream: () => {
        calls.push("stop");
        return Promise.resolve({ ok: true });
      },
      setSuggestedPrompts: () => Promise.resolve({ ok: true }),
    };
    bindSlackAgentClient(client);
    await createSlackAgentExecutor(
      client,
      "slack.agent.say",
    )({
      agentExecutionId: "exec-1",
      toolType: "slack.agent.say",
      args: { text: "Working." },
      outputContext: {
        provider: "slack",
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1700000000.000001",
        slackAgent: { display: "timeline" },
      },
      triggerContext: { event: { slack: { trigger_message: { author: { id: "U1" } } } } },
    });

    let accepted = false;
    await intakeSlackEvent(
      {
        type: "event_callback",
        team_id: "T1",
        api_app_id: "A1",
        event_id: "Ev-stop",
        event_time: 1_700_000_002,
        event: {
          type: "agent_session_stopped",
          channel: "C1",
          thread_ts: "1700000000.000001",
        },
      },
      "signature",
      new Set(),
      {
        appId: "A1",
        accept: () => {
          accepted = true;
          return Promise.resolve({ status: "duplicate", receiptId: "receipt-1" });
        },
      },
    );

    assert.equal(accepted, false);
    assert.deepEqual(calls, ["status", "start", "stop", "status"]);
  });
});
