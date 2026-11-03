import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { OutputExecutionInput } from "../../execution-capabilities/outputs.js";
import { hostedOutputs } from "./hosted-outputs.js";

const input: OutputExecutionInput = {
  agentExecutionId: "execution-1",
  toolType: "slack.react",
  args: { name: "eyes" },
  outputContext: { provider: "slack" },
};

describe("hosted outputs", () => {
  it("delegates a Slack reaction to the inner registration", async () => {
    const calls: unknown[] = [];
    const slot = {
      active: {
        registration: {
          outputs: [
            {
              type: "slack.react",
              tool: {
                name: "react",
                description: "react",
                inputSchema: { type: "object" as const },
              },
              execute: async (received: OutputExecutionInput) => {
                calls.push(received.args);
              },
            },
          ],
        },
      },
    };
    const outputs = hostedOutputs(
      "slack",
      slot,
      async (_active, operation) => {
        await operation();
      },
      (code) => new Error(code),
    );
    const react = outputs.find((output) => output.type === "slack.react");

    assert.ok(react);
    await react.execute(input);
    assert.deepEqual(calls, [{ name: "eyes" }]);
  });

  it("does not expose Slack react on another provider and rejects a retired registration", async () => {
    const outputs = hostedOutputs(
      "github",
      { active: undefined },
      async (_active, operation) => {
        await operation();
      },
      (code) => new Error(code),
    );

    assert.deepEqual(
      outputs.map((output) => output.type),
      ["github.reply"],
    );
    const reply = outputs[0];
    assert.ok(reply);
    await assert.rejects(
      async () => {
        await reply.execute(input);
      },
      (error: unknown) => error instanceof Error && error.message === "github_output_unavailable",
    );
  });
});
