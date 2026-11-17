import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { migrateLegacyBundle } from "./index.js";

const hub = `
environments:
  runner:
    kind: daemon
    daemon: devbox
    cwd: /workspace/company
agents:
  codex:
    provider: codex
    model: gpt-5.6-sol
`;

describe("legacy project bundle migration", () => {
  it("inlines a one-step workflow and its prompt partial into one trigger document", () => {
    const migrated = migrateLegacyBundle({
      files: [
        { path: ".paseo/hub.yml", content: hub },
        {
          path: ".paseo/workflows/slack.yml",
          content: `
name: slack-help
on: slack.mention
max_runtime: 2h
filters:
  connection: acme-slack
  from_users: [U123]
steps:
  - id: work
    environment: runner
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    prompt:
      - include: partials/safety.md
      - text: "Request: \${{ paseo.prompt }}"
    allow_outputs:
      - { type: slack.reply, max: 5 }
`,
        },
        {
          path: ".paseo/workflows/partials/safety.md",
          content: "Never disclose secrets.",
        },
      ],
    });

    assert.equal(migrated.length, 1);
    const trigger = migrated[0];
    assert.equal(trigger?.format, "single_run");
    if (trigger?.format !== "single_run") return;
    assert.match(trigger.yaml, /daemon: devbox/u);
    assert.match(trigger.yaml, /provider: codex/u);
    assert.match(trigger.yaml, /Never disclose secrets\.\n\s+Request:/u);
    assert.doesNotMatch(trigger.yaml, /include:|partials|steps:/u);
  });

  it("keeps the Slack agent surface when a one-step workflow opts in", () => {
    const migrated = migrateLegacyBundle({
      files: [
        { path: ".paseo/hub.yml", content: hub },
        {
          path: ".paseo/workflows/luckyops.yml",
          content: `
name: kevin-luckyops
on: slack.message
max_runtime: 2h
filters:
  from_users: ["*"]
steps:
  - id: run
    environment: runner
    max_runtime: 2h
    idle_timeout: 1h
    agent: codex
    prompt: [{ text: Handle it }]
    slack_agent:
      display: timeline
      session_title: LuckyOps
      feedback: true
    allow_outputs:
      - { type: slack.reply, max: 10 }
`,
        },
      ],
    });

    const trigger = migrated[0];
    assert.equal(trigger?.format, "single_run");
    if (trigger?.format !== "single_run") return;
    assert.match(trigger.yaml, /slack_agent:/u);
    assert.doesNotMatch(trigger.yaml, /steps:/u);
    const step = trigger.compiled.events[0]?.steps[0];
    assert.equal(step?.slackAgent?.display, "timeline");
    assert.equal(step?.slackAgent?.session_title, "LuckyOps");
    assert.equal(step?.slackAgent?.feedback, true);
    assert.deepEqual(
      step?.allowOutputs
        .map((output) => output.type)
        .filter((type) => type.startsWith("slack.agent.")),
      [
        "slack.agent.stage",
        "slack.agent.tool",
        "slack.agent.say",
        "slack.agent.finish",
        "slack.agent.fail",
        "slack.agent.title",
        "slack.agent.prompts",
      ],
    );
  });

  it("keeps the Slack agent surface on a workflow it cannot inline", () => {
    const migrated = migrateLegacyBundle({
      files: [
        { path: ".paseo/hub.yml", content: hub },
        {
          path: ".paseo/workflows/luckyops.yml",
          content: `
name: kevin-luckyops
on: slack.message
max_runtime: 2h
filters:
  from_users: ["*"]
steps:
  - id: classify
    environment: runner
    max_runtime: 2m
    idle_timeout: 30s
    agent: codex
    prompt: [{ text: classify }]
  - id: run
    environment: runner
    max_runtime: 2h
    idle_timeout: 1h
    agent: codex
    prompt: [{ text: Handle it }]
    slack_agent:
      display: timeline
`,
        },
      ],
    });

    const trigger = migrated[0];
    assert.equal(trigger?.format, "legacy_multistep");
    if (trigger?.format !== "legacy_multistep") return;
    assert.equal(trigger.normalized.trigger.steps[1]?.slackAgent?.display, "timeline");
  });

  it("keeps a Slack agent surface off a non-Slack event in the legacy lane", () => {
    const migrated = migrateLegacyBundle({
      files: [
        { path: ".paseo/hub.yml", content: hub },
        {
          path: ".paseo/workflows/issue.yml",
          content: `
name: issue-answer
on: github.issue
max_runtime: 2h
filters:
  from_users: ["*"]
steps:
  - id: run
    environment: runner
    max_runtime: 2h
    idle_timeout: 10m
    agent: codex
    prompt: [{ text: Handle it }]
    slack_agent:
      display: timeline
`,
        },
      ],
    });

    const trigger = migrated[0];
    assert.equal(trigger?.format, "legacy_multistep");
    if (trigger?.format !== "legacy_multistep") return;
    assert.ok(trigger.conversionBlockers.includes("slack_agent cannot run on github.issue"));
    assert.equal(trigger.normalized.trigger.steps[0]?.slackAgent?.display, "timeline");
  });

  it("preserves a multi-step workflow as one self-contained normalized legacy trigger", () => {
    const migrated = migrateLegacyBundle({
      files: [
        { path: ".paseo/hub.yml", content: hub },
        {
          path: ".paseo/workflows/route.yml",
          content: `
name: route
on: manual.run
max_runtime: 2h
steps:
  - id: classify
    environment: runner
    max_runtime: 2m
    idle_timeout: 30s
    agent: codex
    prompt: [{ text: classify }]
  - id: work
    environment: runner
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    prompt: [{ text: work }]
`,
        },
      ],
    });

    assert.equal(migrated[0]?.format, "legacy_multistep");
    const trigger = migrated[0];
    if (trigger?.format !== "legacy_multistep") return;
    assert.equal(trigger.normalized.trigger.steps.length, 2);
    assert.equal(trigger.normalized.environments.length, 1);
    assert.deepEqual(trigger.conversionBlockers, ["trigger has multiple steps"]);
  });
});
