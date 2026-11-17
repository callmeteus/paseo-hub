import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  blankSlackAgentDraft,
  openingSlackAgentBlock,
  outputContextForSlackAgentStep,
  projectSlackAgentDraft,
  SlackAgentBlockSchema,
  slackAgentBlockFromDraft,
  type SlackAgentBlock,
} from "./agent-block.js";

describe("Slack agent block", () => {
  it("accepts each assistant_text mode and rejects anything else", () => {
    for (const assistantText of ["none", "final", "all"] as const) {
      const parsed = SlackAgentBlockSchema.safeParse({
        display: "timeline",
        assistant_text: assistantText,
      });
      assert.equal(parsed.success, true);
      assert.equal(parsed.success ? parsed.data.assistant_text : undefined, assistantText);
    }
    assert.equal(
      SlackAgentBlockSchema.safeParse({ display: "timeline", assistant_text: "some" }).success,
      false,
    );
    assert.equal(SlackAgentBlockSchema.safeParse({ display: "timeline" }).success, true);
  });

  it("round-trips assistant_text through the draft", () => {
    const block: SlackAgentBlock = { display: "plan", assistant_text: "final" };
    const draft = projectSlackAgentDraft(block);
    assert.equal(draft.assistantText, "final");
    assert.deepEqual(slackAgentBlockFromDraft(draft, ["slack.message"]), block);

    const omitted = slackAgentBlockFromDraft({ ...blankSlackAgentDraft(), enabled: true }, [
      "slack.message",
    ]);
    assert.deepEqual(omitted, { display: "plan" });
  });

  it("leaves the mode unset so the surface keeps mirroring every message", () => {
    const block: SlackAgentBlock = { display: "timeline" };
    assert.equal(openingSlackAgentBlock([{ slackAgent: block }]), block);
    // Only an unconditional step may open the session.
    assert.equal(
      openingSlackAgentBlock([{ slackAgent: block, condition: { kind: "literal", value: true } }]),
      undefined,
    );

    const run = {
      provider: "slack",
      organizationId: "org-1",
      slackAgent: { display: "plan" as const },
    };
    assert.deepEqual(outputContextForSlackAgentStep(run, { display: "plan" }), {
      ...run,
      slackAgent: { display: "plan" },
    });
    assert.deepEqual(outputContextForSlackAgentStep(run, { display: "timeline" }), {
      ...run,
      slackAgent: { display: "timeline" },
    });
  });

  it("keeps an explicit mode through the compiler helpers", () => {
    const chosen: SlackAgentBlock = { display: "plan", assistant_text: "none" };
    assert.equal(openingSlackAgentBlock([{ slackAgent: chosen }]), chosen);
    const run = { provider: "slack", organizationId: "org-1" };
    assert.deepEqual(
      outputContextForSlackAgentStep(run, { display: "plan", assistant_text: "all" }),
      {
        ...run,
        slackAgent: { display: "plan", assistant_text: "all" },
      },
    );
  });
});
