import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileTriggerDocument } from "./index.js";
import { applyAutomationTemplate, createWebhookSecret } from "./editor.js";
import type { TriggerFormValue } from "./editor.js";

const form: TriggerFormValue = {
  name: "new-trigger",
  enabled: true,
  event: "manual.run",
  connection: "",
  allowedUsers: "*",
  qualifiers: {},
  daemon: "office",
  cwd: "/workspace",
  agent: "opencode",
  mode: "default",
  thinkingOptionId: "",
  providerOptions: "",
  continuationMode: "conversation",
  continuationKey: "",
  maxRuntime: "2h",
  idleTimeout: "10m",
  githubConnection: "",
  githubRepositories: "",
  githubPermissions: "",
  githubDuration: "1h",
  channels: "",
  webhookSecret: "",
  prompt: "Handle it.",
};

describe("automation templates", () => {
  it("grants slack.reply when the trigger is a Slack message", () => {
    const next = applyAutomationTemplate(form, "slack-message");
    const compiled = compileTriggerDocument(`
name: ${next.name}
enabled: true
on:
  slack.message:
    connection: acme
    filters:
      from_users: ["*"]
      channels: [C1]
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: opencode
    mode: default
  prompt: Read the channel.
`);

    assert.equal(compiled.events[0]?.on, "slack.message");
    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", required: false },
    ]);
  });

  it("keeps a webhook secret on a hub-origin event", () => {
    const secret = createWebhookSecret();
    const compiled = compileTriggerDocument(`
name: webhook
enabled: true
on:
  webhook.received:
    filters:
      webhook_secret: "${secret}"
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: opencode
    mode: default
  prompt: Read the body.
`);

    assert.equal(compiled.events[0]?.on, "webhook.received");
    assert.equal(compiled.events[0]?.filters?.webhook_secret, secret);
    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, []);
  });
});
