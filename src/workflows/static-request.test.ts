import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  callDeployHttp,
  deployActor,
  deployNumber,
  interpolateEnv,
  loadEnvFiles,
} from "./static-request.js";

const STEP = {
  method: "GET" as const,
  url: "https://e7bot.even7.dev/admin/api/deploys",
};

const SENT = {
  headers: { authorization: "Bearer test-key" },
  secrets: ["test-key"],
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

  it("resolves ${var:KEY} from the first dotenv file that has that key", () => {
    const home = mkdtempSync(join(tmpdir(), "env-key-"));
    writeFileSync(join(home, "first.env"), "OTHER=no\nFALLBACK=from-first\nPRIMARY=kept\n");
    writeFileSync(join(home, "second.env"), "PRIMARY=from-second\n");
    const env = loadEnvFiles(["~/first.env", "~/second.env"], home);
    assert.equal(interpolateEnv("${var:PRIMARY}", env).text, "kept");
    assert.equal(
      interpolateEnv("Bearer ${var:MISSING:-${var:FALLBACK}}", env).text,
      "Bearer from-first",
    );
    writeFileSync(join(home, "path.env"), "service.token=from-path\n");
    assert.equal(
      interpolateEnv("${var:service.token}", loadEnvFiles(["~/path.env"], home)).text,
      "from-path",
    );
    assert.equal(
      interpolateEnv("cost $$5 and ${{ steps.gate.outputs.number }}", env).text,
      "cost $5 and ${{ steps.gate.outputs.number }}",
    );
    const skipped = loadEnvFiles(["~/missing.env", "~/second.env"], home);
    assert.equal(interpolateEnv("${var:PRIMARY}", skipped).text, "from-second");
    assert.throws(
      () => interpolateEnv("${var:MISSING}", { OTHER: "secret-value" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes("secret-value"), false);
        assert.match(error.message, /var:MISSING/u);
        return true;
      },
    );
    assert.throws(() => interpolateEnv("${PRIMARY}", env), /var:KEY/u);
  });

  it("reports a free deploy and skips one that is already assigned", async () => {
    const free = await callDeployHttp({
      step: STEP,
      prompt: "Deploy Request #848 por <@U1>",
      triggerContext: undefined,
      ...SENT,
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
      ...SENT,
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
      ...SENT,
      fetch: async (_url, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer test-key");
        assert.equal(headers.get("x-sanddbox-actor"), "U1");
        return new Response("taken", { status: 409 });
      },
    });
    assert.deepEqual(result, { ok: true, output: { assigned: false } });

    const leaked = await callDeployHttp({
      step: { ...STEP, method: "POST", path: "assign" },
      prompt: "Deploy Request #848 por <@U1>",
      triggerContext: undefined,
      ...SENT,
      fetch: async () => new Response("bad test-key", { status: 500 }),
    });
    assert.equal(leaked.ok, false);
    if (leaked.ok) return;
    assert.equal(leaked.reason.includes("test-key"), false);
  });
});
