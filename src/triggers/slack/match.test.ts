import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import type { NormalizedSlackMentionEvent } from "./events.js";
import { matchSlackTriggers, readSlackPromptBody } from "./match.js";

describe("Slack trigger matching", () => {
  it("allows exact, case-sensitive Slack usernames as well as user IDs", () => {
    const config = configForUsers(["operator", "U2"]);

    assert.equal(matchSlackTriggers(config, mention({ username: "operator" }), "UBOT").length, 1);
    assert.equal(matchSlackTriggers(config, mention({ username: "Operator" }), "UBOT").length, 0);
    assert.equal(matchSlackTriggers(config, mention({ authorId: "U2" }), "UBOT").length, 1);
  });

  it("allows every human author only when the wildcard is explicit", () => {
    const config = configForUsers(["*"]);

    assert.equal(matchSlackTriggers(config, mention({ authorId: "stranger" }), "UBOT").length, 1);
  });

  it("requires the compiled trigger filters and bot mention", () => {
    const config = compileHubConfig({
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "slack-run",
          on: "slack.mention",
          max_runtime: "2h",
          filters: {
            workspace: "T1",
            channels: ["C1"],
            from_users: ["U1"],
            pattern: "run",
          },
          steps: [
            {
              id: "run",
              environment: "runner",
              max_runtime: "1h",
              idle_timeout: "5m",
              agent: { provider: "opencode", mode: "default" },
              prompt: [{ text: "Run the request" }],
            },
          ],
        },
      ],
    });
    const event = mention();

    assert.equal(matchSlackTriggers(config, event, "UBOT").length, 1);
    assert.equal(readSlackPromptBody(event, "UBOT"), "run tests");
    assert.equal(
      matchSlackTriggers(config, { ...event, author: { id: "UBOT" } }, "UBOT").length,
      0,
    );
    assert.equal(matchSlackTriggers(config, { ...event, teamId: "T2" }, "UBOT").length, 0);
    assert.equal(matchSlackTriggers(config, { ...event, channelId: "C2" }, "UBOT").length, 0);
    assert.equal(
      matchSlackTriggers(config, { ...event, content: "<@UBOT> please run tests" }, "UBOT").length,
      0,
    );
    assert.equal(matchSlackTriggers(config, { ...event, content: "run tests" }, "UBOT").length, 0);
  });

  it("matches a channel message without a mention and leaves mentions on slack.mention", () => {
    const message = compileHubConfig({
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "channel",
          on: "slack.message",
          max_runtime: "2h",
          filters: { from_users: ["*"] },
          steps: [
            {
              id: "run",
              environment: "runner",
              max_runtime: "1h",
              idle_timeout: "5m",
              agent: { provider: "opencode", mode: "default" },
              prompt: [{ text: "Read the channel" }],
            },
          ],
        },
      ],
    });
    const posted = mention({ authorId: "U9" });
    posted.type = "message";
    posted.content = "hello channel";

    assert.equal(matchSlackTriggers(message, posted, "UBOT").length, 1);
    assert.equal(matchSlackTriggers(configForUsers(["*"]), posted, "UBOT").length, 0);
    assert.equal(matchSlackTriggers(message, mention(), "UBOT").length, 0);
  });

  it("runs a bot message only for the automation that set include_bots", () => {
    const closed = channelConfig(false);
    const open = channelConfig(true);
    const botMessage = mention({ authorId: "U09FFH54LM9" });
    botMessage.type = "message";
    botMessage.content = "Deploy Request #846";
    botMessage.fromBot = true;

    assert.equal(matchSlackTriggers(closed, botMessage, "UBOT").length, 0);
    assert.equal(matchSlackTriggers(open, botMessage, "UBOT").length, 1);
    assert.equal(
      matchSlackTriggers(open, { ...botMessage, author: { id: "UBOT" } }, "UBOT").length,
      0,
    );
    const person = mention({ authorId: "U9" });
    person.type = "message";
    person.content = "hello";
    assert.equal(matchSlackTriggers(closed, person, "UBOT").length, 1);
  });

  it("opens a monitoring alert only for CPU, RAM, or an attack symptom", () => {
    const config = monitoringConfig();
    const open = (content: string, authorId = "U09FFH54LM9") => {
      const event = mention({ authorId });
      event.type = "message";
      event.content = content;
      event.lead = content;
      event.fromBot = authorId === "U09FFH54LM9";
      return matchSlackTriggers(config, event, "UBOT").length;
    };

    assert.equal(open(":rotating_light: ALERTA: [KWA] RDS PI · RAM OS · kwai (99.9% > 85)"), 1);
    assert.equal(open(":rotating_light: ALERTA: [LM/BAR] CPU do Redis acima de 70%"), 1);
    assert.equal(open(":rotating_light: ALERTA: Memória do Redis acima de 90%"), 1);
    assert.equal(open(":rotating_light: ALERTA: [CF] Cloudflare registrou eventos de firewall"), 1);
    assert.equal(open(":white_check_mark: RESOLVIDO: [KWA] RDS PI · RAM OS · kwai"), 0);
    assert.equal(open(":rotating_light: ALERTA: [VVS] RDS PI · Disk Write IOPS · vivasorte"), 0);
    assert.equal(open(":rotating_light: ALERTA: DRAM do host"), 0);
    assert.equal(open(":rotating_light: ALERTA: [KWA] RDS PI · RAM OS · kwai", "U9"), 0);

    const own = mention({ authorId: "UBOT" });
    own.type = "message";
    own.content = ":rotating_light: ALERTA: [KWA] RDS PI · RAM OS · kwai";
    own.lead = own.content;
    own.fromBot = true;
    assert.equal(matchSlackTriggers(config, own, "UBOT").length, 0);
  });
});

function monitoringConfig() {
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "diagnostico-monitoramento",
        on: "slack.message",
        max_runtime: "2h",
        filters: {
          channels: ["C1"],
          from_users: ["U09FFH54LM9"],
          include_bots: true,
          contains_all: ["ALERTA:"],
          contains_any: ["CPU", "RAM", "Memória", "firewall", "WAF", "ataque", "DDoS", "flood"],
        },
        steps: [
          {
            id: "run",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "default" },
            prompt: [{ text: "Diagnose the alert" }],
          },
        ],
      },
    ],
  });
}

function channelConfig(includeBots: boolean) {
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "channel",
        on: "slack.message",
        max_runtime: "2h",
        filters: {
          from_users: ["*"],
          ...(includeBots ? { include_bots: true } : {}),
        },
        steps: [
          {
            id: "run",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "default" },
            prompt: [{ text: "Read the channel" }],
          },
        ],
      },
    ],
  });
}

function configForUsers(fromUsers: string[]) {
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "slack-run",
        on: "slack.mention",
        max_runtime: "2h",
        filters: { workspace: "T1", channels: ["C1"], from_users: fromUsers },
        steps: [
          {
            id: "run",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "default" },
            prompt: [{ text: "Run the request" }],
          },
        ],
      },
    ],
  });
}

function mention(
  overrides: { authorId?: string; username?: string } = {},
): NormalizedSlackMentionEvent {
  return {
    type: "mention",
    id: "Ev1",
    teamId: "T1",
    appId: "A1",
    channelId: "C1",
    messageTs: "1700000000.000001",
    threadTs: "1700000000.000001",
    eventTs: "1700000000.000001",
    eventTime: 1_700_000_001,
    content: "hello <@UBOT> run tests",
    lead: "hello <@UBOT> run tests",
    forwards: [],
    author: {
      id: overrides.authorId ?? "U1",
      ...(overrides.username === undefined ? {} : { username: overrides.username }),
    },
    createdAt: new Date(1_700_000_000_000).toISOString(),
    attachments: [],
  };
}
