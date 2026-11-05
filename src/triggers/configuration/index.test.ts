import assert from "node:assert/strict";
import { parseCompiledHubConfig } from "../../config/compiler.js";
import { parseProjectConfiguration } from "../../configuration/store.js";
import type { ProjectConfigurationRevisionRecord } from "../../db/types.js";
import { describe, it } from "vitest";
import {
  compileTriggerDocument,
  parseTriggerDocument,
  serializeTriggerDocument,
  TriggerDocumentError,
} from "./index.js";
import { singleAgentRun } from "./schema.js";

function unknownGuardrail(error: unknown): boolean {
  assert.ok(error instanceof TriggerDocumentError);
  const mentionsGuardrails = error.issues.some((issue) =>
    issue.path.join(".").startsWith("run.guardrails"),
  );
  assert.equal(mentionsGuardrails, true);
  return true;
}

function reportsMissingEvent(error: unknown): boolean {
  return (
    error instanceof TriggerDocumentError &&
    error.issues.some(
      ({ path, message }) => path.join(".") === "on" && /at least one event/u.test(message),
    )
  );
}

function reportsScheduledRequiredInput(error: unknown): boolean {
  return (
    error instanceof TriggerDocumentError &&
    error.issues.some(
      ({ path, message }) => path.join(".") === "inputs.focus" && /schedule/u.test(message),
    )
  );
}

function reportsEmptyTitle(error: unknown): boolean {
  return (
    error instanceof TriggerDocumentError &&
    error.issues.some(({ path }) => path.join(".") === "run.title")
  );
}

const trigger = `
name: engineering-requests
enabled: true
on:
  slack.mention:
    connection: acme-slack
    filters:
      channels: [engineering]
      from_users: [U0BNGPZEXT2]
  github.issue_comment:
    connection: getpaseo-github
    filters:
      contains: "@paseo-bot"
      from_users: [boudra]
inputs:
  model:
    type: string
    default: codex
    choices: [codex, claude]
run:
  target:
    daemon: devbox
    cwd: /workspace/company
  agent:
    select: \${{ paseo.inputs.model }}
    choices:
      codex:
        provider: codex
        model: gpt-5.6-sol
      claude:
        provider: claude
        model: claude-opus-5
  max_runtime: 90m
  idle_timeout: 10m
  github:
    connection: getpaseo-github
    repositories: [getpaseo/paseo, getpaseo/hub]
    permissions:
      contents: write
      pull_requests: write
  prompt: |
    Use Paseo when delegation is useful.
    \${{ paseo.prompt }}
  outputs:
    slack.reply:
      max: 5
`;

describe("self-contained trigger documents", () => {
  it.each([undefined, false, true])("compiles and round-trips background %s", (background) => {
    const yaml =
      background === undefined
        ? trigger
        : trigger.replace(
            "run:",
            `run:
  background: ${background}`,
          );
    const compiled = compileTriggerDocument(yaml);
    assert.equal(singleAgentRun(compiled.authored.run).background, background ?? false);
    assert.equal(compiled.events[0]?.steps[0]?.background, background ?? false);
    assert.equal(
      singleAgentRun(parseTriggerDocument(serializeTriggerDocument(compiled.authored)).run)
        .background,
      background ?? false,
    );
  });

  it("rejects a non-boolean background value", () => {
    assert.throws(
      () => parseTriggerDocument(trigger.replace("run:", 'run:\n  background: "true"')),
      /run.background/,
    );
  });

  it("compiles and preserves a configurable startup timeout", () => {
    const yaml = trigger.replace("  max_runtime: 90m", "  max_runtime: 90m\n  startup_timeout: 3m");
    const compiled = compileTriggerDocument(yaml);
    assert.equal(compiled.events[0]?.steps[0]?.startupTimeoutMs, 180_000);
    assert.equal(
      singleAgentRun(parseTriggerDocument(serializeTriggerDocument(compiled.authored)).run)
        .startup_timeout,
      "3m",
    );
  });

  it("compiles an authored title template and preserves it through canonical YAML", () => {
    const title = "Intake · ${{ paseo.execution.id }}";
    const yaml = trigger.replace("  max_runtime: 90m", `  max_runtime: 90m\n  title: "${title}"`);
    const compiled = compileTriggerDocument(yaml);
    assert.equal(compiled.events[0]?.steps[0]?.title, title);
    assert.equal(
      singleAgentRun(parseTriggerDocument(serializeTriggerDocument(compiled.authored)).run).title,
      title,
    );
  });

  it("rejects an empty title at the document boundary", () => {
    assert.throws(
      () =>
        parseTriggerDocument(
          trigger.replace("  max_runtime: 90m", '  max_runtime: 90m\n  title: ""'),
        ),
      reportsEmptyTitle,
    );
  });

  it.each(["0s", "25h", "invalid"])("rejects invalid startup timeout %s", (duration) => {
    assert.throws(
      () =>
        compileTriggerDocument(
          trigger.replace(
            "  max_runtime: 90m",
            `  max_runtime: 90m\n  startup_timeout: ${duration}`,
          ),
        ),
      /startup_timeout/,
    );
  });

  it("compiles every input event to one launch against the inline target and agent choices", () => {
    const compiled = compileTriggerDocument(trigger);

    assert.equal(compiled.authored.name, "engineering-requests");
    assert.equal(compiled.environment.kind, "daemon");
    assert.equal(compiled.events.length, 2);
    assert.deepEqual(
      compiled.events.map(({ on }) => on),
      ["slack.mention", "github.issue_comment"],
    );
    assert.deepEqual(compiled.events[0]?.steps[0]?.agent, {
      selector: "${{ paseo.inputs.model }}",
      choices: {
        codex: { provider: "codex", model: "gpt-5.6-sol" },
        claude: { provider: "claude", model: "claude-opus-5" },
      },
    });
    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", max: 5, required: false },
      { type: "slack.react", required: false },
    ]);
    assert.deepEqual(compiled.events[1]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", max: 5, required: false },
      { type: "github.reply", required: false },
    ]);
    assert.equal(compiled.events[0]?.guardrails, undefined);
  });

  it("compiles guardrails onto every event and leaves the prompt alone", () => {
    const rails = [{ id: "slack.same_channel" }, { id: "slack.same_thread", options: {} }];
    const yaml = trigger.replace(
      "  outputs:\n",
      "  guardrails:\n    - id: slack.same_channel\n    - id: slack.same_thread\n      options: {}\n  outputs:\n",
    );
    const compiled = compileTriggerDocument(yaml);
    assert.deepEqual(compiled.events[0]?.guardrails, rails);
    assert.deepEqual(compiled.events[1]?.guardrails, rails);
    const prompt = compiled.events[0]?.steps[0]?.prompt[0];
    assert.equal(prompt?.kind, "text");
    if (prompt?.kind === "text") {
      assert.match(prompt.value, /Use Paseo/);
      assert.doesNotMatch(prompt.value, /same_channel/);
    }
    const stored = parseCompiledHubConfig({
      environments: [compiled.environment],
      triggers: compiled.events,
    });
    assert.deepEqual(stored.triggers[0]?.guardrails, rails);
    assert.deepEqual(
      singleAgentRun(parseTriggerDocument(serializeTriggerDocument(compiled.authored)).run)
        .guardrails,
      rails,
    );
  });

  it("rejects an unknown guardrail id", () => {
    assert.throws(
      () =>
        parseTriggerDocument(
          trigger.replace(
            "  outputs:\n",
            "  guardrails:\n    - id: slack.somewhere_else\n  outputs:\n",
          ),
        ),
      unknownGuardrail,
    );
  });

  it("rejects a bare guardrail string", () => {
    assert.throws(
      () =>
        parseTriggerDocument(
          trigger.replace("  outputs:\n", "  guardrails:\n    - slack.same_channel\n  outputs:\n"),
        ),
      unknownGuardrail,
    );
  });

  it("rejects an unknown guardrail option", () => {
    assert.throws(
      () =>
        parseTriggerDocument(
          trigger.replace(
            "  outputs:\n",
            "  guardrails:\n    - id: slack.same_channel\n      options:\n        extra: true\n  outputs:\n",
          ),
        ),
      unknownGuardrail,
    );
  });

  it("round-trips the semantic document through canonical YAML", () => {
    const parsed = parseTriggerDocument(trigger);
    assert.deepEqual(parseTriggerDocument(serializeTriggerDocument(parsed)), parsed);
  });

  it("allows authenticated manual dispatches when no actor filter is authored", () => {
    const compiled = compileTriggerDocument(`
name: deploy
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex }
  prompt: Handle it
`);

    assert.deepEqual(compiled.events[0]?.filters?.from_users, ["*"]);
    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, []);
  });

  it("automatically grants an unlimited event-native reply for a new conversational trigger", () => {
    const compiled = compileTriggerDocument(`
name: answer
on:
  slack.mention:
    connection: acme-slack
    filters: { from_users: ["*"] }
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
`);

    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", required: false },
      { type: "slack.react", required: false },
    ]);
  });

  it("rejects a trigger without events at the document boundary", () => {
    assert.throws(
      () =>
        parseTriggerDocument(`
name: empty
on: {}
run:
  target: { daemon: local, cwd: /workspace }
  agent: { provider: codex }
  prompt: run
`),
      reportsMissingEvent,
    );
  });

  it("refuses a schedule beside an input that a tick cannot supply", () => {
    const scheduled = (input: string) => `
name: watch
inputs:
  focus: ${input}
on:
  schedule.tick:
    recurrence: { start: "2026-01-01T09:00:00", rule: "FREQ=DAILY", timezone: UTC }
  manual.run: {}
run:
  target: { daemon: local, cwd: /workspace }
  agent: { provider: codex }
  prompt: run
`;
    assert.equal(
      Object.keys(parseTriggerDocument(scheduled("{ type: string, default: everything }")).on)
        .length,
      2,
    );
    assert.throws(
      () => parseTriggerDocument(scheduled("{ type: string, required: true }")),
      reportsScheduledRequiredInput,
    );
  });
});

it("applies the continuation default when reading old trigger revisions without rewriting their evidence", () => {
  const compiled = compileTriggerDocument(trigger);
  const stored = structuredClone({
    environments: [{ ...compiled.environment, daemonId: "daemon" }],
    triggers: compiled.events,
  });
  for (const event of stored.triggers) for (const step of event.steps) delete step.continuation;
  const revision: ProjectConfigurationRevisionRecord = {
    id: "revision",
    projectId: "project",
    organizationId: "org",
    version: 1,
    sourceKind: "manual",
    sourceEvidence: { kind: "organization_trigger_adapter" },
    rawYaml: trigger,
    normalizedConfiguration: stored,
    validationErrors: null,
    contentHash: "original",
    createdByUserId: "user",
    receivedAt: null,
    createdAt: new Date(),
    validatedAt: new Date(),
  };
  const loaded = parseProjectConfiguration(revision);
  assert.deepEqual(loaded.triggers[0]?.steps[0]?.continuation, { mode: "conversation" });
  assert.equal(stored.triggers[0]?.steps[0]?.continuation, undefined);
  const legacy = parseProjectConfiguration({ ...revision, sourceEvidence: { kind: "manual" } });
  assert.equal(legacy.triggers[0]?.steps[0]?.continuation, undefined);
  const migratedLegacy = parseProjectConfiguration({
    ...revision,
    rawYaml: JSON.stringify({
      name: "preserved-workflow",
      legacy_multistep: { trigger: stored.triggers[0], environments: stored.environments },
    }),
  });
  assert.deepEqual(migratedLegacy, legacy);
});

it("keeps a Cursor model, thinking option, and Fast feature through compile", () => {
  const yaml = `
name: model-pin
enabled: true
on:
  manual.run: {}
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    model: grok-4.7
    mode: agent
    thinkingOptionId: high
    features:
      fast: "false"
  prompt: Reply.
`;
  const parsed = parseTriggerDocument(yaml);

  // A single agent, not a named choice
  const run = singleAgentRun(parsed.run);
  if ("choices" in run.agent) {
    assert.fail("expected one agent");
  }

  assert.equal(run.agent.model, "grok-4.7");
  assert.equal(run.agent.thinkingOptionId, "high");
  assert.deepEqual(run.agent.features, { fast: "false" });

  const compiled = compileTriggerDocument(yaml);
  const agent = compiled.events[0]?.steps[0]?.agent;

  // Compile keeps the same agent fields
  if (agent === undefined || "selector" in agent) {
    assert.fail("expected a compiled agent");
  }

  assert.equal(agent.model, "grok-4.7");
  assert.equal(agent.thinkingOptionId, "high");
  assert.deepEqual(agent.features, { fast: "false" });
});

it("rejects a boolean Fast feature", () => {
  const yaml = `
name: model-pin
enabled: true
on:
  manual.run: {}
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    mode: agent
    features:
      fast: false
  prompt: Reply.
`;

  assert.throws(() => parseTriggerDocument(yaml), TriggerDocumentError);
});

const reactionFlow = `
name: pause-then-reply
enabled: true
on:
  manual.run: {}
run:
  target:
    daemon: office
    cwd: /workspace
  reactions:
    - id: pause
      wait:
        for: 5m
    - id: check
      if:
        condition: "\${{ paseo.prompt == 'later' }}"
        then:
          - id: run
            agent:
              provider: codex
              mode: agent
            prompt: Reply now.
        else:
          - id: later
            wait:
              for: 1h
`;

it("keeps guardrails on a reaction flow", () => {
  const compiled = compileTriggerDocument(
    reactionFlow.replace(
      "  reactions:",
      "  guardrails:\n    - id: slack.same_thread\n  reactions:",
    ),
  );
  assert.deepEqual(compiled.events[0]?.guardrails, [{ id: "slack.same_thread" }]);
});

it("compiles a wait and a condition into ordered steps", () => {
  const compiled = compileTriggerDocument(reactionFlow);
  const steps = compiled.events[0]?.steps;
  assert.equal(steps?.length, 3);
  assert.equal(steps?.[0]?.id, "pause");
  assert.equal(steps?.[0]?.waitMs, 5 * 60 * 1000);
  assert.equal(steps?.[0]?.condition, undefined);

  const reply = steps?.[1];
  const delayed = steps?.[2];
  assert.equal(reply?.id, "run");
  assert.equal(reply?.waitMs, undefined);
  assert.equal(reply?.condition?.kind, "binary");
  assert.equal(delayed?.id, "later");
  assert.equal(delayed?.waitMs, 60 * 60 * 1000);
  assert.equal(delayed?.condition?.kind, "not");
});

it("rejects a condition with no branch and a wait with a bad duration", () => {
  assert.throws(
    () =>
      parseTriggerDocument(`
name: empty-check
enabled: true
on:
  manual.run: {}
run:
  target:
    daemon: office
    cwd: /workspace
  reactions:
    - id: check
      if:
        condition: "\${{ paseo.prompt != '' }}"
        then: []
        else: []
`),
    /true or a false branch/u,
  );
  assert.throws(
    () => compileTriggerDocument(reactionFlow.replace("for: 5m", "for: soon")),
    TriggerDocumentError,
  );
});
