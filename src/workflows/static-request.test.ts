import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { callDeployHttp, deployActor, deployNumber, readE7ApiKey } from "./static-request.js";

const STEP = {
  method: "GET" as const,
  url: "https://e7bot.even7.dev/admin/api/deploys",
};

describe("deploy request step", () => {
  it("reads the deploy number and the requester named on the card", () => {
    const prompt = "Deploy Request #848 por <@U094ZL7KXK6>";
    assert.equal(deployNumber(prompt), "848");
    assert.equal(deployActor(prompt, undefined), "U094ZL7KXK6");
  });

  it("uses the message author when the card does not name a requester", () => {
    assert.equal(
      deployActor("compila agora", {
        event: { slack: { trigger_message: { author: { id: "U123" } } } },
      }),
      "U123",
    );
  });

  it("prefers the key in ~/.lm.credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "e7-key-"));
    writeFileSync(join(home, ".lm.credentials"), "EVEN_AGENT_API_KEY=from-new\n");
    writeFileSync(join(home, ".lemon.credentials"), "EVEN_AGENT_API_KEY=from-old\n");
    assert.equal(readE7ApiKey(home), "from-new");
  });

  it("reports a free deploy and skips one that is already assigned", async () => {
    const free = await callDeployHttp({
      step: STEP,
      prompt: "Deploy Request #848 por <@U1>",
      triggerContext: undefined,
      apiKey: "test-key",
      fetch: async () =>
        Response.json({ status: "AWAITING", assignedTo: null, buildAreas: ["proxy"] }),
    });
    assert.equal(free.ok, true);
    if (!free.ok) return;
    assert.equal(free.output["open"], true);
    assert.equal(free.output["number"], "848");

    const taken = await callDeployHttp({
      step: STEP,
      prompt: "Deploy Request #848 por <@U1>",
      triggerContext: undefined,
      apiKey: "test-key",
      fetch: async () => Response.json({ status: "ASSIGNED", assignedTo: "U9" }),
    });
    assert.equal(taken.ok, true);
    if (!taken.ok) return;
    assert.equal(taken.output["open"], false);
    assert.equal(taken.output["assignee"], " e foi assumido por <@U9>");
  });

  it("treats HTTP 409 on assign as someone else taking the deploy", async () => {
    const result = await callDeployHttp({
      step: { ...STEP, method: "POST", path: "assign" },
      prompt: "Deploy Request #848 por <@U1>",
      triggerContext: undefined,
      apiKey: "test-key",
      fetch: async () => new Response("taken", { status: 409 }),
    });
    assert.deepEqual(result, { ok: true, output: { assigned: false } });
  });
});
