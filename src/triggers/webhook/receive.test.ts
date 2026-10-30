import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createWebhookSecret } from "../configuration/editor.js";
import type { ManualTriggerInput } from "../manual/schema.js";
import { receiveAutomationWebhook } from "./receive.js";

const secret = createWebhookSecret();
const yaml = `
name: inbound
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
`;

describe("receiveAutomationWebhook", () => {
  it("dispatches the automation named in the document", async () => {
    const seen: ManualTriggerInput[] = [];
    const result = await receiveAutomationWebhook({
      database: {
        async listEnabledTriggerDocuments() {
          return [
            {
              organizationId: "org",
              projectId: "11111111-1111-4111-8111-111111111111",
              triggerName: "stored-name",
              configurationRevisionId: "rev",
              yaml,
            },
          ];
        },
      },
      dispatch: async (input) => {
        seen.push(input);
      },
      secret,
      body: { hello: "world" },
    });

    assert.equal(result.status, "accepted");
    assert.equal(seen[0]?.source, "webhook.received");
    assert.equal(isRecord(seen[0]?.payload) ? seen[0]?.payload["trigger"] : undefined, "inbound");
  });

  it("does not dispatch an unknown secret", async () => {
    const result = await receiveAutomationWebhook({
      database: {
        async listEnabledTriggerDocuments() {
          return [];
        },
      },
      dispatch: async () => {
        throw new Error("unknown secret must not dispatch");
      },
      secret: createWebhookSecret(),
      body: {},
    });

    assert.equal(result.status, "not_found");
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
