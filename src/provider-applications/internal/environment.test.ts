import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { readProviderApplicationEnvironment } from "./environment.js";

describe("Slack provider environment", () => {
  const webhook = {
    SLACK_APP_ID: "A1",
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_SIGNING_SECRET: "signing",
  };

  it.each([
    [
      { SLACK_TRANSPORT: "socket", SLACK_APP_ID: "A1", SLACK_APP_TOKEN: "xapp-token" },
      { provider: "slack", transport: "socket", appId: "A1", appToken: "xapp-token" },
    ],
    [
      webhook,
      {
        provider: "slack",
        transport: "webhook",
        appId: "A1",
        clientId: "client",
        clientSecret: "secret",
        signingSecret: "signing",
      },
    ],
    [
      { ...webhook, SLACK_TRANSPORT: "webhook" },
      {
        provider: "slack",
        transport: "webhook",
        appId: "A1",
        clientId: "client",
        clientSecret: "secret",
        signingSecret: "signing",
      },
    ],
  ] as const)("accepts a complete Slack group", async (environment, expected) => {
    assert.deepEqual((await readProviderApplicationEnvironment(environment)).slack, expected);
  });

  it("rejects partial, mixed, and unknown Slack groups", async () => {
    for (const environment of [
      { SLACK_APP_ID: "A1" },
      { SLACK_TRANSPORT: "socket", SLACK_APP_ID: "A1" },
      {
        SLACK_TRANSPORT: "socket",
        SLACK_APP_ID: "A1",
        SLACK_APP_TOKEN: "xapp-token",
        SLACK_SIGNING_SECRET: "mixed",
      },
      { SLACK_TRANSPORT: "magic", SLACK_APP_ID: "A1" },
    ]) {
      await assert.rejects(
        readProviderApplicationEnvironment(environment),
        /Slack environment configuration/i,
      );
    }
  });
});

describe("Telegram provider environment", () => {
  it("reads bot token and optional webhook secret", async () => {
    const result = await readProviderApplicationEnvironment({
      TELEGRAM_BOT_TOKEN: "12345:token",
      TELEGRAM_WEBHOOK_SECRET: "secret",
    });
    assert.deepEqual(result.telegram, {
      provider: "telegram",
      botToken: "12345:token",
      secretToken: "secret",
    });
  });

  it("returns undefined without a bot token", async () => {
    const result = await readProviderApplicationEnvironment({});
    assert.equal(result.telegram, undefined);
  });
});
