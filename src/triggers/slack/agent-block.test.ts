import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  blankSlackAgentDraft,
  defaultSlackAgentAssistantText,
  openingSlackAgentBlock,
  outputContextForSlackAgentStep,
  projectSlackAgentDraft,
  SlackAgentBlockSchema,
  slackAgentBlockFromDraft,
  withSlackAgentAssistantText,
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

  it("defaults to none when the step can reply and all when it cannot", () => {
    assert.equal(defaultSlackAgentAssistantText([{ type: "slack.reply" }]), "none");
    assert.equal(defaultSlackAgentAssistantText([{ type: "slack.react" }]), "all");
    assert.equal(defaultSlackAgentAssistantText([]), "all");

    const block: SlackAgentBlock = { display: "plan" };
    assert.deepEqual(withSlackAgentAssistantText(block, [{ type: "slack.reply" }]), {
      display: "plan",
      assistant_text: "none",
    });
    assert.deepEqual(withSlackAgentAssistantText(block, [{ type: "slack.react" }]), {
      display: "plan",
      assistant_text: "all",
    });
    const chosen: SlackAgentBlock = { display: "plan", assistant_text: "final" };
    assert.equal(withSlackAgentAssistantText(chosen, [{ type: "slack.reply" }]), chosen);
  });

  it("fills the opening block from the outputs that step was granted", () => {
    const block: SlackAgentBlock = { display: "timeline" };
    assert.deepEqual(openingSlackAgentBlock([{ slackAgent: block, allowOutputs: [] }]), {
      display: "timeline",
      assistant_text: "all",
    });
    assert.equal(
      openingSlackAgentBlock([
        { slackAgent: block, condition: { kind: "literal", value: true } },
        { slackAgent: block, allowOutputs: [{ type: "slack.reply" }] },
      ])?.assistant_text,
      "none",
    );
  });

  it("resolves the same default when the step builds its own output context", () => {
    const run = {
      provider: "slack",
      organizationId: "org-1",
      slackAgent: { display: "plan" as const },
    };
    assert.deepEqual(
      outputContextForSlackAgentStep(run, { display: "plan" }, [{ type: "slack.reply" }]),
      {
        ...run,
        slackAgent: { display: "plan", assistant_text: "none" },
      },
    );
    assert.deepEqual(outputContextForSlackAgentStep(run, { display: "plan" }), {
      ...run,
      slackAgent: { display: "plan" },
    });
  });
});
