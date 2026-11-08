import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig, parseCompiledHubConfig } from "../../config/index.js";
import { parseTriggerDocument } from "../configuration/index.js";
import type { NormalizedSlackMentionEvent } from "./events.js";
import { slackChoiceArrival } from "./feedback.js";
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
    event.content = "run <@UBOT> tests";
    event.lead = event.content;

    assert.deepEqual(config.triggers[0]?.filters?.regex, [String.raw`^run(?!\S)`]);
    assert.equal(matchSlackTriggers(config, event, "UBOT").length, 1);
    assert.equal(readSlackPromptBody(mention(), "UBOT"), "run tests");
    assert.equal(
      matchSlackTriggers(config, { ...event, content: "hello <@UBOT> run tests" }, "UBOT").length,
      0,
    );
    assert.equal(
      matchSlackTriggers(config, { ...event, content: "running <@UBOT> now" }, "UBOT").length,
      0,
    );
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

  it("lets a direct message through only when the trigger opts in", () => {
    const optedIn = compileHubConfig({
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "channel",
          on: "slack.message",
          max_runtime: "2h",
          filters: { from_users: ["*"], channels: ["C1"], direct_messages: true },
          steps: [
            {
              id: "run",
              environment: "runner",
              max_runtime: "1h",
              idle_timeout: "5m",
              agent: { provider: "opencode", mode: "default" },
              prompt: [{ text: "Read the message" }],
            },
          ],
        },
      ],
    });
    const closed = channelConfig(false);
    const direct = {
      ...channelMessage("logs do tenant"),
      channelId: "D1",
      channelType: "im" as const,
      threadTs: null,
    };

    assert.equal(matchSlackTriggers(optedIn, direct, "UBOT").length, 1);
    assert.equal(matchSlackTriggers(optedIn, channelMessage("no canal"), "UBOT").length, 1);
    assert.equal(matchSlackTriggers(closed, direct, "UBOT").length, 0);
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

  it("requires every regex to match the raw message", () => {
    const config = messageConfig({ regex: ["ALERTA:", "CPU"] });
    assert.equal(matched(config, "ALERTA: CPU hot"), 1);
    assert.equal(matched(config, "cpu alerta:"), 0);
    assert.equal(matched(config, "ALERTA: disk"), 0);
  });

  it("does not filter text when regex is omitted", () => {
    const config = messageConfig({});
    assert.equal(matched(config, "anything at all"), 1);
  });

  it("fails an invalid regex instead of matching", () => {
    const event = channelMessage("ALERTA: CPU");
    assert.throws(
      () =>
        matchSlackTriggers(
          {
            triggers: [
              { name: "bad", on: "slack.message", filters: { from_users: ["*"], regex: ["("] } },
            ],
          },
          event,
          "UBOT",
        ),
      /Invalid Slack message regex/u,
    );
    assert.throws(
      () =>
        matchSlackTriggers(
          {
            triggers: [
              { name: "bad", on: "slack.message", filters: { from_users: ["*"], regex: [] } },
            ],
          },
          event,
          "UBOT",
        ),
      /Slack message regex must not be empty/u,
    );
  });

  it("rejects an invalid or empty regex in the document", () => {
    assert.throws(
      () => parseTriggerDocument(regexDocument("regex: ['(']")),
      /Invalid Slack message regex/u,
    );
    assert.throws(
      () => parseTriggerDocument(regexDocument("regex: []")),
      /Slack message regex must not be empty/u,
    );
    assert.throws(
      () => compileHubConfig(messageTrigger({ regex: ["("] })),
      /Invalid Slack message regex/u,
    );
  });

  it("does not also apply legacy text fields when regex is set", () => {
    const config = messageConfig({ regex: ["disk"], contains_all: ["ALERTA:"] });
    assert.equal(matched(config, "disk is full"), 1);
    assert.equal(matched(config, "ALERTA: CPU"), 0);
  });

  it("matches a literal with a letter boundary and does not compile it as a regex", () => {
    const bug = messageConfig({ text: ["bug"] });
    assert.equal(matched(bug, "a bug here"), 1);
    assert.equal(matched(bug, "BUG!"), 1);
    assert.equal(matched(bug, "debug"), 0);
    assert.equal(matched(bug, "bugs"), 0);
    const literal = messageConfig({ text: ["ALERTA:", "a.b", "(?i)CPU"] });
    assert.equal(matched(literal, "alerta: a.b (?i)CPU"), 1);
    assert.equal(matched(literal, "ALERTA: axb (?i)CPU"), 0);
    assert.equal(matched(literal, "cpu"), 0);
    assert.equal(messageConfig({ text: ["RAM"] }).triggers[0]?.filters?.regex, undefined);
    assert.equal(matched(messageConfig({ text: ["RAM"] }), "DRAM"), 0);
    assert.equal(matched(messageConfig({ text: ["RAM"] }), "see ram now"), 1);
  });

  it("compiles a text regex item as written, including a leading (?i)", () => {
    const config = messageConfig({
      text: ["ALERTA:", { regex: "(?i)CPU|RAM|Memória|firewall|WAF|ataque|DDoS|flood" }],
    });
    assert.equal(matched(config, "alerta: ram"), 1);
    assert.equal(matched(config, "ALERTA: memória"), 1);
    assert.equal(matched(config, "ALERTA: DRAM"), 1);
    assert.equal(matched(config, "ALERTA: disk"), 0);
    assert.equal(matched(config, "ram only"), 0);
  });

  it("requires every text item and every regex when both are set", () => {
    const config = messageConfig({ text: ["ALERTA:"], regex: ["disk"] });
    assert.deepEqual(config.triggers[0]?.filters?.regex, ["disk"]);
    assert.deepEqual(config.triggers[0]?.filters?.text, ["ALERTA:"]);
    assert.equal(matched(config, "ALERTA: disk"), 1);
    assert.equal(matched(config, "alerta: disk"), 1);
    assert.equal(matched(config, "ALERTA: cpu"), 0);
    assert.equal(matched(config, "disk"), 0);
  });

  it("keeps a stored regex list on the regex field and matching the same alert text", () => {
    const config = messageConfig({
      regex: [
        String.raw`(?i:(?<![\p{L}\p{N}])ALERTA:(?![\p{L}\p{N}]))`,
        String.raw`(?i:(?<![\p{L}\p{N}])(?:CPU|RAM|Memória|firewall|WAF|ataque|DDoS|flood)(?![\p{L}\p{N}]))`,
      ],
    });
    assert.equal(config.triggers[0]?.filters?.text, undefined);
    assert.equal(
      matched(config, ":rotating_light: ALERTA: [KWA] RDS PI · RAM OS · kwai (99.9% > 85)"),
      1,
    );
    assert.equal(matched(config, ":rotating_light: ALERTA: DRAM do host"), 0);
    assert.equal(
      matched(config, ":rotating_light: ALERTA: [VVS] RDS PI · Disk Write IOPS · vivasorte"),
      0,
    );
  });

  it("does not migrate legacy terms when text is already set", () => {
    const config = messageConfig({ text: ["disk"], contains_all: ["ALERTA:"] });
    assert.equal(config.triggers[0]?.filters?.regex, undefined);
    assert.equal(matched(config, "disk is full"), 1);
    assert.equal(matched(config, "ALERTA: CPU"), 0);
  });

  it("fails an invalid, empty, or wrongly shaped text list", () => {
    const event = channelMessage("ALERTA: CPU");
    assert.throws(
      () =>
        matchSlackTriggers(
          {
            triggers: [
              {
                name: "bad",
                on: "slack.message",
                filters: { from_users: ["*"], text: [{ regex: "(" }] },
              },
            ],
          },
          event,
          "UBOT",
        ),
      /Invalid Slack message regex/u,
    );
    assert.throws(
      () =>
        matchSlackTriggers(
          {
            triggers: [
              {
                name: "bad",
                on: "slack.message",
                filters: { from_users: ["*"], regex: ["disk"], text: [{ regex: "(" }] },
              },
            ],
          },
          channelMessage("other"),
          "UBOT",
        ),
      /Invalid Slack message regex/u,
    );
    assert.throws(
      () =>
        matchSlackTriggers(
          {
            triggers: [
              { name: "bad", on: "slack.message", filters: { from_users: ["*"], text: [] } },
            ],
          },
          event,
          "UBOT",
        ),
      /Slack message text must not be empty/u,
    );
    assert.throws(
      () => parseTriggerDocument(regexDocument("text: []")),
      /Slack message text must not be empty/u,
    );
    assert.throws(
      () => parseTriggerDocument(regexDocument('text:\n        - ""')),
      /Slack message text must not be empty/u,
    );
    assert.throws(
      () => parseTriggerDocument(regexDocument("text:\n        - regex: ''")),
      /Slack message regex must not be empty/u,
    );
    assert.throws(
      () => parseTriggerDocument(regexDocument("text:\n        - pattern: no")),
      /Slack message text must be a string or a regex/u,
    );
    assert.throws(
      () => parseTriggerDocument(regexDocument("text:\n        - regex: '('")),
      /Invalid Slack message regex/u,
    );
    const literalParentheses = messageConfig({ text: ["("] });
    assert.equal(matched(literalParentheses, "see ( now"), 1);
    assert.equal(matched(literalParentheses, "see now"), 0);
  });

  it("migrates a stored contains_all document when the compiled config is loaded", () => {
    const compiled = monitoringConfig();
    assert.deepEqual(compiled.triggers[0]?.filters?.regex, [
      String.raw`(?i:(?<![\p{L}\p{N}])ALERTA:(?![\p{L}\p{N}]))`,
      String.raw`(?i:(?<![\p{L}\p{N}])(?:CPU|RAM|Memória|firewall|WAF|ataque|DDoS|flood)(?![\p{L}\p{N}]))`,
    ]);
    const trigger = compiled.triggers[0];
    if (trigger?.filters === undefined) throw new Error("missing filters");
    const { regex: _regex, ...filters } = trigger.filters;
    const loaded = parseCompiledHubConfig({
      ...compiled,
      triggers: [{ ...trigger, filters }],
    });
    const event = channelMessage(":rotating_light: ALERTA: [KWA] RDS PI · RAM OS · kwai");
    event.fromBot = true;
    event.author = { id: "U09FFH54LM9" };
    assert.equal(matchSlackTriggers(loaded, event, "UBOT").length, 1);
  });

  it("matches a plan decision only on a Slack trigger that asks for feedback", () => {
    const sentence = slackChoiceArrival({ label: "Ship it", value: "ship" });
    const decision: NormalizedSlackMentionEvent = {
      ...mention(),
      type: "message",
      content: sentence,
      lead: sentence,
      planDecision: "ship",
    };
    const withFeedback = feedbackConfig(true);
    assert.equal(matchSlackTriggers(withFeedback, decision, "UBOT").length, 1);
    assert.equal(matchSlackTriggers(feedbackConfig(false), decision, "UBOT").length, 0);
    assert.equal(
      matchSlackTriggers(withFeedback, { ...decision, author: { id: "U9" } }, "UBOT").length,
      0,
    );
    assert.equal(
      matchSlackTriggers(withFeedback, { ...decision, channelId: "C2" }, "UBOT").length,
      0,
    );
  });

  it("runs one agent when a click lands in a channel that also listens for mentions", () => {
    const sentence = slackChoiceArrival({ label: "Pode lançar", value: "lancar" });
    const decision: NormalizedSlackMentionEvent = {
      ...mention(),
      type: "message",
      content: sentence,
      lead: sentence,
      planDecision: "lancar",
    };
    const clicks = matchSlackTriggers(messageAndMentionFeedback(), decision, "UBOT");
    assert.deepEqual(
      clicks.map((item) => item.trigger.name),
      ["kevin-message"],
    );

    const mentionOnly: NormalizedSlackMentionEvent = { ...decision, channelId: "C-OPS" };
    assert.deepEqual(
      matchSlackTriggers(messageAndMentionFeedback(), mentionOnly, "UBOT").map(
        (item) => item.trigger.name,
      ),
      ["kevin-mention"],
    );
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

function messageConfig(filters: {
  regex?: string[];
  contains_all?: string[];
  text?: Array<string | { regex: string }>;
}) {
  return compileHubConfig(messageTrigger(filters));
}

function messageTrigger(filters: {
  regex?: string[];
  contains_all?: string[];
  text?: Array<string | { regex: string }>;
}) {
  return {
    environments: [{ name: "runner", kind: "daemon" as const, daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "channel",
        on: "slack.message",
        max_runtime: "2h",
        filters: { from_users: ["*"], ...filters },
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
  };
}

function matched(config: Parameters<typeof matchSlackTriggers>[0], content: string): number {
  return matchSlackTriggers(config, channelMessage(content), "UBOT").length;
}

function channelMessage(content: string): NormalizedSlackMentionEvent {
  const event = mention({ authorId: "U9" });
  event.type = "message";
  event.content = content;
  event.lead = content;
  return event;
}

function regexDocument(filterLine: string): string {
  return `
name: bad
enabled: true
on:
  slack.message:
    filters:
      from_users: ["*"]
      ${filterLine}
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    mode: agent
  prompt: Reply.
`;
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

function messageAndMentionFeedback() {
  const step = {
    id: "run",
    environment: "runner",
    max_runtime: "1h",
    idle_timeout: "5m",
    agent: { provider: "opencode", mode: "default" },
    prompt: [{ text: "Run the request" }],
    slack_agent: { display: "timeline" as const, feedback: true },
  };
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "kevin-message",
        on: "slack.message",
        max_runtime: "2h",
        filters: { channels: ["C1"], from_users: ["*"] },
        steps: [step],
      },
      {
        name: "kevin-mention",
        on: "slack.mention",
        max_runtime: "2h",
        filters: { channels: ["C1", "C-OPS"], from_users: ["*"] },
        steps: [step],
      },
    ],
  });
}

function feedbackConfig(feedback: boolean) {
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "slack-run",
        on: "slack.mention",
        max_runtime: "2h",
        filters: { workspace: "T1", channels: ["C1"], from_users: ["U1"], pattern: "ALERTA" },
        steps: [
          {
            id: "run",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "default" },
            prompt: [{ text: "Run the request" }],
            ...(feedback ? { slack_agent: { display: "plan" as const, feedback: true } } : {}),
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
