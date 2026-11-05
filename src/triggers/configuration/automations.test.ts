import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileTriggerDocument } from "./index.js";
import { emptyWorktree, textInstructions } from "./form-drafts.js";
import { applyAutomationTemplate, createWebhookSecret } from "./editor.js";
import type { TriggerFormValue } from "./editor.js";

const form: TriggerFormValue = {
  name: "new-trigger",
  enabled: true,
  event: "manual.run",
  events: ["manual.run"],
  includeBots: false,
  connection: "",
  allowedUsers: "*",
  qualifiers: {},
  daemon: "office",
  cwd: "/workspace",
  agent: "opencode",
  mode: "default",
  thinkingOptionId: "",
  cursorFast: "",
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
  guardrails: [],
  worktree: emptyWorktree(),
  prompt: textInstructions("Handle it."),
};

describe("automation templates", () => {
  it("grants slack.reply and slack.react when the trigger is a Slack message", () => {
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
      { type: "slack.react", required: false },
    ]);
  });

  it("keeps include_bots off unless the automation turns it on", () => {
    const off = compileTriggerDocument(`
name: channel-watch
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
    const on = compileTriggerDocument(`
name: channel-watch
enabled: true
on:
  slack.message:
    connection: acme
    filters:
      from_users: ["*"]
      channels: [C1]
      include_bots: true
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: opencode
    mode: default
  prompt: Read the channel.
`);

    assert.equal(off.events[0]?.filters?.include_bots, undefined);
    assert.equal(on.events[0]?.filters?.include_bots, true);
  });

  it("rejects a preset reactions block", () => {
    assert.throws(
      () =>
        compileTriggerDocument(`
name: slack-react
enabled: true
on:
  slack.message:
    connection: acme
    filters:
      from_users: ["*"]
    reactions:
      looking: eyes
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: opencode
    mode: default
  prompt: Read the channel.
`),
      /reactions/u,
    );
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
