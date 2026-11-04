import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { cleanTriggerAgent, continuationAgentIdentity, executionFeatureValues } from "./index.js";

describe("cleanTriggerAgent", () => {
  it("keeps configured model and thinking options while omitting absent optional fields", () => {
    assert.deepEqual(
      cleanTriggerAgent({
        provider: "codex",
        model: "gpt-5.6-sol",
        mode: "full-access",
        thinkingOptionId: "xhigh",
      }),
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        mode: "full-access",
        thinkingOptionId: "xhigh",
      },
    );
    assert.deepEqual(cleanTriggerAgent({ provider: "codex", mode: "full-access" }), {
      provider: "codex",
      mode: "full-access",
    });
    assert.deepEqual(cleanTriggerAgent({ provider: "codex" }), { provider: "codex" });
  });

  it("copies opaque provider options without interpreting their keys", () => {
    const options = { permission: { edit: "ask", bash: "deny" } };
    const cleaned = cleanTriggerAgent({ provider: "opencode", options });
    assert.deepEqual(cleaned, { provider: "opencode", options });
    assert.notEqual(cleaned.options, options);
  });

  it("copies feature values without sharing the object", () => {
    const features = { fast: "false" };
    const cleaned = cleanTriggerAgent({ provider: "cursor", features });

    assert.deepEqual(cleaned.features, features);
    assert.notEqual(cleaned.features, features);
  });
});

describe("executionFeatureValues", () => {
  it("turns Cursor Fast off when the workflow does not set it", () => {
    assert.deepEqual(executionFeatureValues({ provider: "cursor" }), {
      fast: "false",
      auto_accept: true,
    });
    assert.deepEqual(executionFeatureValues({ provider: "opencode" }), {
      auto_accept: true,
    });
  });

  it("keeps an authored Fast value and still auto-accepts", () => {
    assert.deepEqual(
      executionFeatureValues({
        provider: "cursor",
        features: { fast: "true", auto_accept: "false" },
      }),
      {
        fast: "true",
        auto_accept: true,
      },
    );
  });
});

describe("continuationAgentIdentity", () => {
  it("leaves model, thinking, and Fast out of an existing thread", () => {
    assert.deepEqual(
      continuationAgentIdentity({
        provider: "cursor",
        mode: "agent",
        model: "grok-4.7",
        thinkingOptionId: "high",
        features: { fast: "false" },
      }),
      {
        provider: "cursor",
        mode: "agent",
      },
    );
  });

  it("keeps provider options in the continuation identity", () => {
    const options = { permission: { edit: "ask" } };

    assert.deepEqual(
      continuationAgentIdentity({
        provider: "opencode",
        options,
      }),
      {
        provider: "opencode",
        options,
      },
    );
  });
});
