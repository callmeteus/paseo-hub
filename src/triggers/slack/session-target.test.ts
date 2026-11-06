import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { slackExecutionTargetsSession } from "./session-target.js";

const session = { teamId: "T1", channelId: "C1", threadTs: "1.1" };

describe("slackExecutionTargetsSession", () => {
  it("matches the reply target and ignores a different thread", () => {
    const target = { provider: "slack", teamId: "T1", channelId: "C1", threadTs: "1.1" };
    assert.equal(
      slackExecutionTargetsSession({ outputContext: target, triggerContext: {} }, session),
      true,
    );
    assert.equal(
      slackExecutionTargetsSession(
        {
          outputContext: { ...target, threadTs: "2.2" },
          triggerContext: { provider: "slack", target },
        },
        session,
      ),
      true,
    );
    assert.equal(
      slackExecutionTargetsSession(
        {
          outputContext: { ...target, channelId: "C2" },
          triggerContext: { provider: "slack", target: { ...target, channelId: "C2" } },
        },
        session,
      ),
      false,
    );
  });
});
