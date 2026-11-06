import { EDITOR_EVENTS } from "./events.js";
import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";
import { ReactionFlow } from "./reaction-form.js";
import { singleAgentRun, TriggerDocumentSchema } from "./schema.js";
import {
  changeTriggerEvent,
  createTriggerYaml,
  describeTriggerEvent,
  mergeTriggerForm,
  patchTriggerYaml,
  projectTriggerForm,
  splitAgentId,
  triggerFormErrors,
} from "./editor.js";
import { emptyWorktree, textInstructions } from "./form-drafts.js";
import { blankSlackAgentDraft, SLACK_AGENT_FEEDBACK_UNAVAILABLE } from "../slack/agent-block.js";
import { setEventAudience, setEventRegex, toggleTriggerEvent } from "./form-events.js";

import {
  GITHUB_SEMANTIC_TRIGGER_EVENT_NAMES,
  GITHUB_TRIGGER_SOURCE_NAMES,
} from "../github/classification.js";

const ADVANCED = `# keep this heading
name: answer
enabled: true
on:
  slack.mention:
    connection: company
    filters:
      from_users: ["*"]
      channels: [engineering]
inputs:
  urgency:
    type: string
    default: normal
max_runtime: 4h
run:
  target:
    daemon: office
    cwd: /workspace
    worktree:
      mode: branch-off
      newBranch: hub-work
  agent:
    provider: codex
    model: gpt-5.4
    mode: full-access
    thinkingOptionId: xhigh
    options:
      sandbox_mode: workspace-write
      approval_policy: never
  prompt: Handle it.
  max_runtime: 3h
  idle_timeout: 15m
  startup_timeout: 3m
  env:
    TEAM: core
  github:
    connection: company-github
    repositories: [paseo/hub]
  output:
    schema:
      type: object
  outputs:
    slack.reply:
      max: 3
  auto_archive: false
`;

describe("trigger form YAML bridge", () => {
  test("returns the original YAML byte-for-byte when the form did not change", () => {
    const projection = projectTriggerForm(ADVANCED);
    expect(projection.status).toBe("editable");
    if (projection.status === "editable") {
      expect(patchTriggerYaml(ADVANCED, projection.value)).toBe(ADVANCED);
    }
  });

  test("patches owned nodes while preserving comments and advanced configuration", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const yaml = patchTriggerYaml(ADVANCED, {
      ...projection.value,
      cwd: "/new-workspace",
      agent: "pi/gateway/vendor/model-v1",
      mode: "safe",
    });
    expect(yaml).toContain("# keep this heading");
    const value = TriggerDocumentSchema.parse(parseDocument(yaml).toJS());
    const run = singleAgentRun(value.run);
    expect(value.run.target).toEqual({
      daemon: "office",
      cwd: "/new-workspace",
      worktree: { mode: "branch-off", newBranch: "hub-work" },
    });
    expect(run.agent).toEqual({
      provider: "pi",
      model: "gateway/vendor/model-v1",
      mode: "safe",
      thinkingOptionId: "xhigh",
      options: { sandbox_mode: "workspace-write", approval_policy: "never" },
    });
    expect(value.inputs).toBeDefined();
    expect(value.max_runtime).toBe("4h");
    expect(run.startup_timeout).toBe("3m");
    expect(run.env).toEqual({ TEAM: "core" });
    expect(run.github).toEqual({
      connection: "company-github",
      repositories: ["paseo/hub"],
    });
    expect(run.output).toBeDefined();
    expect(run.outputs).toEqual({ "slack.reply": { max: 3 } });
    expect(run.auto_archive).toBe(false);
    expect(value.on["slack.mention"]?.filters?.channels).toEqual(["engineering"]);
  });

  test("edits provider options without touching thinking selection", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const yaml = patchTriggerYaml(ADVANCED, {
      ...projection.value,
      providerOptions: '{"sandbox_mode":"read-only"}',
    });
    const value = TriggerDocumentSchema.parse(parseDocument(yaml).toJS());
    const run = singleAgentRun(value.run);
    if ("choices" in run.agent) throw new Error("expected an inline agent");
    expect(run.agent.options).toEqual({ sandbox_mode: "read-only" });
    expect(run.agent.thinkingOptionId).toBe("xhigh");
  });

  test("keeps advanced YAML added before a new trigger's first save", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const merged = mergeTriggerForm(ADVANCED, {
      ...projection.value,
      prompt: textInstructions("Changed."),
    });
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(merged.yaml).toContain("# keep this heading");
    const value = TriggerDocumentSchema.parse(parseDocument(merged.yaml).toJS());
    const run = singleAgentRun(value.run);
    expect(run.prompt).toBe("Changed.");
    expect(run.target.worktree).toBeDefined();
    expect(run.outputs).toBeDefined();
  });

  test("keeps run.guardrails when the form saves another field", () => {
    const yaml = ADVANCED.replace(
      "  auto_archive: false\n",
      "  auto_archive: false\n  guardrails:\n    - id: slack.same_channel\n    - id: slack.same_thread\n      options: {}\n",
    );
    const projection = projectTriggerForm(yaml);
    expect(projection.status).toBe("editable");
    if (projection.status !== "editable") throw new Error(projection.reason);
    expect(patchTriggerYaml(yaml, projection.value)).toBe(yaml);
    const saved = patchTriggerYaml(yaml, {
      ...projection.value,
      prompt: textInstructions("Changed."),
    });
    const value = TriggerDocumentSchema.parse(parseDocument(saved).toJS());
    const run = singleAgentRun(value.run);
    expect(run.guardrails).toEqual([
      { id: "slack.same_channel" },
      { id: "slack.same_thread", options: {} },
    ]);
    expect(run.prompt).toBe("Changed.");
  });

  test("edits two Slack events, bot messages, and Cursor Fast in the form", () => {
    const yaml = `
name: pedido-deploy
enabled: true
on:
  slack.message:
    connection: slack-office
    filters:
      from_users:
        - "*"
      channels:
        - C096XDA2478
      include_bots: true
  slack.mention:
    connection: slack-office
    filters:
      from_users:
        - "*"
      channels:
        - C096XDA2478
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    mode: agent
    model: grok-4.7
    thinkingOptionId: high
    features:
      fast: "false"
  prompt: Reply.
  max_runtime: 2h
  idle_timeout: 10m
`;
    const projection = projectTriggerForm(yaml);
    expect(projection.status).toBe("editable");
    if (projection.status !== "editable") return;
    expect(projection.value.events).toEqual(["slack.message", "slack.mention"]);
    expect(projection.value.includeBots).toBe(true);
    expect(projection.value.agent).toBe("cursor/grok-4.7");
    expect(projection.value.thinkingOptionId).toBe("high");
    expect(projection.value.cursorFast).toBe("false");
    expect(patchTriggerYaml(yaml, projection.value)).toBe(yaml);

    const withoutMention = patchTriggerYaml(
      yaml,
      toggleTriggerEvent(projection.value, "slack.mention", false),
    );
    const parsed = TriggerDocumentSchema.parse(parseDocument(withoutMention).toJS());
    expect(Object.keys(parsed.on)).toEqual(["slack.message"]);
    expect(parsed.on["slack.message"]?.filters?.include_bots).toBe(true);
    const parsedRun = singleAgentRun(parsed.run);
    if ("choices" in parsedRun.agent) throw new Error("expected one agent");
    expect(parsedRun.agent.features).toEqual({ fast: "false" });

    const fast = patchTriggerYaml(yaml, { ...projection.value, cursorFast: "true" });
    const spedUp = TriggerDocumentSchema.parse(parseDocument(fast).toJS());
    const spedRun = singleAgentRun(spedUp.run);
    if ("choices" in spedRun.agent) throw new Error("expected one agent");
    expect(spedRun.agent.features).toEqual({ fast: "true" });
    expect(spedUp.on["slack.mention"]?.filters?.channels).toEqual(["C096XDA2478"]);
  });

  test("edits events that listen to different people and match different text", () => {
    const yaml = `
name: diagnostico-monitoramento
enabled: true
on:
  slack.message:
    connection: slack-office
    filters:
      from_users:
        - U09FFH54LM9
      channels:
        - C096V21TE0K
      include_bots: true
      regex:
        - '(?i:(?<![\\p{L}\\p{N}])ALERTA:(?![\\p{L}\\p{N}]))'
        - '(?i:(?<![\\p{L}\\p{N}])(?:CPU|RAM|Memória)(?![\\p{L}\\p{N}]))'
  slack.mention:
    connection: slack-office
    filters:
      from_users:
        - "*"
      channels:
        - C096V21TE0K
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    mode: agent
    model: grok-4.7
    thinkingOptionId: high
    features:
      fast: "false"
  prompt: Reply.
  max_runtime: 2h
  idle_timeout: 10m
`;
    const projection = projectTriggerForm(yaml);
    expect(projection.status).toBe("editable");
    if (projection.status !== "editable") return;
    expect(projection.value.eventUsers?.["slack.message"]).toBe("U09FFH54LM9");
    expect(projection.value.eventUsers?.["slack.mention"]).toBe("*");
    expect(projection.value.regex?.["slack.message"]).toContain("ALERTA:");
    expect(projection.value.regex?.["slack.message"]).toContain("Memória");
    expect(patchTriggerYaml(yaml, projection.value)).toBe(yaml);

    const widened = patchTriggerYaml(
      yaml,
      setEventAudience(projection.value, "slack.mention", "U123"),
    );
    const parsed = TriggerDocumentSchema.parse(parseDocument(widened).toJS());
    expect(parsed.on["slack.mention"]?.filters?.from_users).toEqual(["U123"]);
    expect(parsed.on["slack.message"]?.filters?.from_users).toEqual(["U09FFH54LM9"]);
    expect(parsed.on["slack.message"]?.filters?.regex?.[1]).toContain("Memória");

    const narrowed = patchTriggerYaml(
      yaml,
      setEventRegex(projection.value, "slack.message", "regex: (?i:a{1,3})\nregex: CPU"),
    );
    const terms = TriggerDocumentSchema.parse(parseDocument(narrowed).toJS());
    expect(terms.on["slack.message"]?.filters?.regex).toEqual(["(?i:a{1,3})", "CPU"]);
    expect(terms.on["slack.message"]?.filters?.text).toBeUndefined();
    expect(terms.on["slack.mention"]?.filters?.from_users).toEqual(["*"]);
  });

  test("writes a literal line and a regex line as text", () => {
    const yaml = `
name: diagnostico-monitoramento
enabled: true
on:
  slack.message:
    connection: slack-office
    filters:
      from_users: ["U09FFH54LM9"]
      include_bots: true
      regex:
        - '(?i:(?<![\\p{L}\\p{N}])ALERTA:(?![\\p{L}\\p{N}]))'
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    mode: agent
  prompt: Reply.
`;
    const projection = projectTriggerForm(yaml);
    if (projection.status !== "editable") throw new Error(projection.reason);
    expect(patchTriggerYaml(yaml, projection.value)).toBe(yaml);
    const edited = patchTriggerYaml(
      yaml,
      setEventRegex(projection.value, "slack.message", "ALERTA:\nregex: (?i:CPU|RAM)"),
    );
    const parsed = TriggerDocumentSchema.parse(parseDocument(edited).toJS());
    expect(parsed.on["slack.message"]?.filters?.text).toEqual([
      "ALERTA:",
      { regex: "(?i:CPU|RAM)" },
    ]);
    expect(parsed.on["slack.message"]?.filters?.regex).toBeUndefined();
    expect(parsed.on["slack.message"]?.filters?.include_bots).toBe(true);
    expect(parsed.on["slack.message"]?.filters?.from_users).toEqual(["U09FFH54LM9"]);
  });

  test("keeps a text list byte for byte when the form saves", () => {
    const yaml = `
name: diagnostico-monitoramento
enabled: true
on:
  slack.message:
    connection: slack-office
    filters:
      from_users: ["U09FFH54LM9"]
      text:
        - "ALERTA:"
        - regex: "(?i:CPU|RAM)"
      regex:
        - disk
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    mode: agent
  prompt: Reply.
`;
    const projection = projectTriggerForm(yaml);
    if (projection.status !== "editable") throw new Error(projection.reason);
    expect(projection.value.regex?.["slack.message"]).toContain("ALERTA:");
    expect(projection.value.regex?.["slack.message"]).toContain("regex: (?i:CPU|RAM)");
    expect(projection.value.regex?.["slack.message"]).toContain("regex: disk");
    expect(patchTriggerYaml(yaml, projection.value)).toBe(yaml);
    const widened = patchTriggerYaml(
      yaml,
      setEventAudience(projection.value, "slack.message", "U123"),
    );
    expect(widened).toContain('regex: "(?i:CPU|RAM)"');
    expect(widened).toContain("- disk");
    const parsed = TriggerDocumentSchema.parse(parseDocument(widened).toJS());
    expect(parsed.on["slack.message"]?.filters?.from_users).toEqual(["U123"]);
    expect(parsed.on["slack.message"]?.filters?.text).toEqual([
      "ALERTA:",
      { regex: "(?i:CPU|RAM)" },
    ]);
    expect(parsed.on["slack.message"]?.filters?.regex).toEqual(["disk"]);
  });

  test("keeps a literal the form cannot show in YAML", () => {
    const yaml = `
name: wrapped
enabled: true
on:
  slack.message:
    connection: slack-office
    filters:
      from_users: ["*"]
      text:
        - "regex: not a literal the form can show"
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    mode: agent
  prompt: Reply.
`;
    const projection = projectTriggerForm(yaml);
    expect(projection).toEqual({
      status: "yaml_only",
      reason: "A message pattern cannot be edited in the form.",
    });
  });

  test("removes regex when the pattern field is cleared", () => {
    const yaml = `
name: diagnostico-monitoramento
enabled: true
on:
  slack.message:
    connection: slack-office
    filters:
      from_users: ["U09FFH54LM9"]
      regex: ["ALERTA:", "CPU"]
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    mode: agent
  prompt: Reply.
`;
    const projection = projectTriggerForm(yaml);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const cleared = patchTriggerYaml(yaml, setEventRegex(projection.value, "slack.message", ""));
    const parsed = TriggerDocumentSchema.parse(parseDocument(cleared).toJS());
    expect(parsed.on["slack.message"]?.filters?.regex).toBeUndefined();
    expect(parsed.on["slack.message"]?.filters?.from_users).toEqual(["U09FFH54LM9"]);
  });

  test("keeps legacy Slack term lists when the form saves", () => {
    const yaml = `
name: diagnostico-monitoramento
enabled: true
on:
  slack.message:
    connection: slack-office
    filters:
      from_users: ["U09FFH54LM9"]
      include_bots: true
      contains_all: ["ALERTA:"]
      contains_any: ["CPU", "flood"]
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    mode: agent
  prompt: Reply.
`;
    const projection = projectTriggerForm(yaml);
    expect(projection.status).toBe("editable");
    if (projection.status !== "editable") return;
    expect(projection.value.regex?.["slack.message"]).toBe("");
    expect(patchTriggerYaml(yaml, projection.value)).toBe(yaml);
  });

  test("keeps a pattern the form cannot show in YAML", () => {
    const yaml = `
name: wrapped
enabled: true
on:
  slack.message:
    connection: slack-office
    filters:
      from_users: ["*"]
      regex:
        - "a\\nb"
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    mode: agent
  prompt: Reply.
`;
    const projection = projectTriggerForm(yaml);
    expect(projection).toEqual({
      status: "yaml_only",
      reason: "A message pattern cannot be edited in the form.",
    });
    const merged = mergeTriggerForm(yaml, {
      name: "wrapped",
      enabled: true,
      event: "slack.message",
      events: ["slack.message"],
      includeBots: false,
      connection: "slack-office",
      allowedUsers: "*",
      qualifiers: {},
      daemon: "office",
      cwd: "/workspace",
      agent: "cursor",
      mode: "agent",
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
      prompt: textInstructions("Reply."),
      slackAgent: blankSlackAgentDraft(),
      guardrails: [],
      worktree: emptyWorktree(),
      channels: "",
      webhookSecret: "",
    });
    expect(merged).toEqual({
      status: "incomplete",
      reason: "A message pattern cannot be edited in the form.",
    });
  });

  test("adds a second Slack event without dropping the first", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const yaml = patchTriggerYaml(
      ADVANCED,
      toggleTriggerEvent(projection.value, "slack.message", true),
    );
    const parsed = TriggerDocumentSchema.parse(parseDocument(yaml).toJS());
    expect(Object.keys(parsed.on)).toEqual(["slack.mention", "slack.message"]);
    expect(parsed.on["slack.message"]?.filters?.channels).toEqual(["engineering"]);
    expect(parsed.on["slack.mention"]?.filters?.channels).toEqual(["engineering"]);
  });

  test("keeps events that disagree in YAML-only mode", () => {
    const projection = projectTriggerForm(`
name: split
enabled: true
on:
  slack.message:
    connection: one
    filters:
      from_users: ["*"]
  slack.mention:
    connection: two
    filters:
      from_users: ["*"]
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    mode: agent
  prompt: Reply.
`);
    expect(projection).toEqual({
      status: "yaml_only",
      reason: "These events use different connections.",
    });
  });

  test("keeps unsupported shapes in YAML-only mode", () => {
    expect(projectTriggerForm(ADVANCED.replace("slack.mention:", "custom.event:"))).toEqual({
      status: "yaml_only",
      reason: "The form does not support the custom.event event.",
    });
    expect(
      projectTriggerForm(
        ADVANCED.replace(
          "provider: codex\n    model: gpt-5.4",
          "select: primary\n    choices:\n      primary:\n        provider: codex",
        ),
      ).status,
    ).toBe("yaml_only");
  });

  test("creates a deliberately minimal new trigger", () => {
    const yaml = createTriggerYaml({
      name: "answer",
      enabled: true,
      event: "manual.run",
      events: ["manual.run"],
      includeBots: false,
      connection: "",
      allowedUsers: "*",
      qualifiers: {},
      daemon: "office",
      cwd: "/workspace",
      agent: "codex/gpt-5.4",
      mode: "full-access",
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
      prompt: textInstructions("Handle it."),
      slackAgent: blankSlackAgentDraft(),
      guardrails: [],
      worktree: emptyWorktree(),
      channels: "",
      webhookSecret: "",
    });
    expect(parseDocument(yaml).toJS()).toEqual({
      name: "answer",
      enabled: true,
      on: { "manual.run": {} },
      run: {
        target: { daemon: "office", cwd: "/workspace" },
        agent: { provider: "codex", model: "gpt-5.4", mode: "full-access" },
        continuation: { mode: "conversation" },
        max_runtime: "2h",
        idle_timeout: "10m",
        prompt: "Handle it.",
      },
    });
  });

  test("submits an unchanged minimal manual trigger", () => {
    const initial = createTriggerYaml({
      name: "deploy",
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
      mode: "full-access",
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
      prompt: textInstructions("${{ paseo.prompt }}"),
      slackAgent: blankSlackAgentDraft(),
      guardrails: [],
      worktree: emptyWorktree(),
      channels: "",
      webhookSecret: "",
    });
    const projection = projectTriggerForm(initial);
    if (projection.status !== "editable") throw new Error(projection.reason);

    const merged = mergeTriggerForm(initial, { ...projection.value, name: "release" });
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(merged.yaml).toContain("name: release");
  });

  test("splits only the first slash in a full agent ID", () => {
    expect(splitAgentId("pi/gateway/vendor/model-v1")).toEqual({
      provider: "pi",
      model: "gateway/vendor/model-v1",
    });
  });

  test("reports the missing field instead of throwing when the form is half filled", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);

    expect(mergeTriggerForm("", { ...projection.value, daemon: "" })).toEqual({
      status: "incomplete",
      reason: "Daemon is required.",
    });
    expect(mergeTriggerForm("", { ...projection.value, agent: "" })).toEqual({
      status: "incomplete",
      reason: "Agent is required.",
    });
    expect(mergeTriggerForm("", { ...projection.value, providerOptions: "{" })).toEqual({
      status: "incomplete",
      reason: "Provider options must be valid JSON.",
    });
  });

  test("serialises a complete new trigger that has no document yet", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);

    const merged = mergeTriggerForm("", projection.value);
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(merged.yaml).toContain("daemon: office");
  });
});

describe("what the form still needs", () => {
  function editable() {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    return projection.value;
  }

  test("finds nothing wrong with a document that already parses", () => {
    expect(triggerFormErrors(editable())).toEqual({});
  });

  test("names the field, not just the problem", () => {
    expect(triggerFormErrors({ ...editable(), daemon: "" })).toEqual({
      daemon: "Daemon is required.",
    });
    expect(triggerFormErrors({ ...editable(), cwd: "workspace" })).toEqual({
      cwd: "Working directory must be an absolute path.",
    });
    expect(triggerFormErrors({ ...editable(), agent: "" })).toEqual({
      agent: "Agent is required.",
    });
    expect(triggerFormErrors({ ...editable(), providerOptions: "{" })).toEqual({
      providerOptions: "Provider options must be valid JSON.",
    });
    expect(triggerFormErrors({ ...editable(), prompt: textInstructions("  ") })).toEqual({
      prompt: "Instructions are required.",
    });
  });

  test("holds the name to the document's own alphabet", () => {
    expect(triggerFormErrors({ ...editable(), name: "" }).name).toBe("Trigger name is required.");
    expect(triggerFormErrors({ ...editable(), name: "Slack Triage" }).name).toBe(
      "Use lowercase letters, digits, and hyphens, starting with a letter.",
    );
    expect(triggerFormErrors({ ...editable(), name: "slack-triage" }).name).toBeUndefined();
  });

  test("asks for a connection only when an event arrives on one", () => {
    expect(triggerFormErrors({ ...editable(), connection: "" }).connection).toBe(
      "Connection is required.",
    );
    expect(
      triggerFormErrors({ ...editable(), event: "manual.run", connection: "", allowedUsers: "" })
        .connection,
    ).toBeUndefined();
  });

  test("reads GitHub permissions only when a GitHub connection is chosen", () => {
    expect(
      triggerFormErrors({ ...editable(), githubConnection: "", githubPermissions: "{" })
        .githubPermissions,
    ).toBeUndefined();
    expect(
      triggerFormErrors({ ...editable(), githubConnection: "company", githubPermissions: "{" })
        .githubPermissions,
    ).toBe("GitHub permissions must be valid JSON.");
    expect(
      triggerFormErrors({
        ...editable(),
        githubConnection: "company",
        githubPermissions: '{"a":1}',
      }).githubPermissions,
    ).toBe('GitHub permissions map a scope to "read", "write", or "admin".');
  });

  test("reports the topmost problem when the document cannot be written at all", () => {
    expect(mergeTriggerForm("", { ...editable(), name: "", daemon: "" })).toEqual({
      status: "incomplete",
      reason: "Trigger name is required.",
    });
  });
});

test.each([
  "github.pull_request_created",
  "github.pull_request_ready_for_review",
  "github.issue_created",
  "linear.issue_assigned",
  "linear.comment_created",
  "linear.issue_entered_scope",
])("edits supported event %s", (event) => {
  expect(projectTriggerForm(ADVANCED.replace("slack.mention", event)).status).toBe("editable");
});

test("round trips the added label separately from existing item labels", () => {
  const yaml = ADVANCED.replace("slack.mention", "github.pull_request_label_added").replace(
    "channels: [engineering]",
    "label: ready\n      labels: [bug]",
  );
  const projection = projectTriggerForm(yaml);
  expect(projection.status).toBe("editable");
  if (projection.status !== "editable") throw new Error("not editable");
  expect(projection.value.qualifiers.label).toBe("ready");
  const patched = patchTriggerYaml(yaml, { ...projection.value, qualifiers: { label: "review" } });
  expect(
    TriggerDocumentSchema.parse(parseDocument(patched).toJS()).on["github.pull_request_label_added"]
      ?.filters,
  ).toEqual({
    from_users: ["*"],
    label: "review",
    labels: ["bug"],
  });
  expect(() => patchTriggerYaml(patched, { ...projection.value, qualifiers: {} })).toThrow(
    "Added label is required.",
  );
});

test("offers every supported GitHub semantic event and webhook source", () => {
  for (const event of [...GITHUB_SEMANTIC_TRIGGER_EVENT_NAMES, ...GITHUB_TRIGGER_SOURCE_NAMES]) {
    expect(EDITOR_EVENTS).toContain(event);
  }
});

test("creates a qualified event and removes the qualifier when changing event kind", () => {
  const initial = projectTriggerForm(ADVANCED);
  if (initial.status !== "editable") throw new Error(initial.reason);
  const yaml = createTriggerYaml({
    ...initial.value,
    event: "github.issue_label_added",
    qualifiers: { label: "ready" },
  });
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  expect(projection.value.qualifiers.label).toBe("ready");
  const changed = patchTriggerYaml(yaml, {
    ...projection.value,
    event: "github.pull_request_created",
  });
  expect(
    TriggerDocumentSchema.parse(parseDocument(changed).toJS()).on["github.pull_request_created"]
      ?.filters,
  ).toEqual({ from_users: ["*"] });
});

test("event changes carry compatible qualifiers and reset provider-bound values", () => {
  const projection = projectTriggerForm(
    ADVANCED.replace("slack.mention", "github.issue_label_added").replace(
      "channels: [engineering]",
      "label: ready",
    ),
  );
  if (projection.status !== "editable") throw new Error(projection.reason);
  const initial = { ...projection.value, qualifiers: { label: "ready" } };
  const pr = changeTriggerEvent(initial, "github.pull_request_label_added");
  expect(pr.qualifiers).toEqual({ label: "ready" });
  expect(pr.connection).toBe(initial.connection);
  const created = changeTriggerEvent(pr, "github.issue_created");
  expect(created.qualifiers).toEqual({});
  const slack = changeTriggerEvent(pr, "slack.mention");
  expect(slack.qualifiers).toEqual({});
  expect(slack.connection).toBe("");
});

test.each(["github.issue_label_added", "github.pull_request_label_added"])(
  "requires an added label for %s",
  (event) => {
    const projection = projectTriggerForm(
      ADVANCED.replace("slack.mention", event).replace("channels: [engineering]", "label: ready"),
    );
    if (projection.status !== "editable") throw new Error(projection.reason);
    expect(triggerFormErrors({ ...projection.value, qualifiers: { label: "  " } })).toEqual({
      "qualifiers.label": "Added label is required.",
    });
    expect(triggerFormErrors({ ...projection.value, qualifiers: {} })).toEqual({
      "qualifiers.label": "Added label is required.",
    });
  },
);

test.each(["github.issue_label_added", "github.pull_request_label_added"])(
  "rejects YAML without an added label for %s",
  (event) => {
    const missing = ADVANCED.replace("slack.mention", event);
    expect(TriggerDocumentSchema.safeParse(parseDocument(missing).toJS()).success).toBe(false);
    const blank = missing.replace("channels: [engineering]", 'label: "   "');
    expect(TriggerDocumentSchema.safeParse(parseDocument(blank).toJS()).success).toBe(false);
  },
);

test("continuation policies round-trip through the form and YAML", () => {
  const projection = projectTriggerForm(ADVANCED);
  if (projection.status !== "editable") throw new Error(projection.reason);
  expect(projection.value.continuationMode).toBe("conversation");
  for (const mode of ["key", "new", "conversation"]) {
    const yaml = patchTriggerYaml(ADVANCED, {
      ...projection.value,
      continuationMode: mode,
      continuationKey: "${{ paseo.inputs.ticket }}",
    });
    const next = projectTriggerForm(yaml);
    expect(next).toMatchObject({ status: "editable", value: { continuationMode: mode } });
    expect(yaml).toContain("# keep this heading");
  }
});

test("a trigger row names the event kind before what narrows it", () => {
  const projection = projectTriggerForm(ADVANCED);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const slack = projection.value;
  expect(describeTriggerEvent(slack, "slack.mention")).toEqual({
    kind: "Slack mention",
    detail: "company",
  });
  // The recurrence used to stand in for the kind, so a schedule's row never said "Schedule".
  const schedule = {
    ...slack,
    event: "schedule.tick" as const,
    connection: "",
    recurrence: { start: "2026-01-01T08:15:00", rule: "FREQ=DAILY", timezone: "UTC" },
  };
  expect(describeTriggerEvent(schedule, "schedule.tick")).toEqual({
    kind: "Schedule",
    detail: "Every day at 08:15 (UTC)",
  });
  expect(
    describeTriggerEvent({ ...slack, event: "manual.run", connection: "" }, "manual.run"),
  ).toEqual({
    kind: "Manual run",
  });
  expect(describeTriggerEvent(null, "github.push")).toEqual({ kind: "GitHub push" });
});

const reactionYaml = `
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
        condition: "\${{ paseo.prompt != '' }}"
        then:
          - id: run
            agent:
              provider: codex
              mode: agent
            prompt: Reply.
        else:
          - id: later
            wait:
              for: 1h
`;

test("projects a wait and a condition, then patches the wait", () => {
  const projection = projectTriggerForm(reactionYaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const flow = projection.value.flow;
  if (flow === undefined) throw new Error("expected a reaction flow");
  expect(flow.map((reaction) => reaction.type)).toEqual(["wait", "if"]);
  const pause = flow[0];
  const check = flow[1];
  if (pause?.type !== "wait" || check?.type !== "if")
    throw new Error("expected wait then condition");
  expect(pause.duration).toBe("5m");
  expect(check.then.map((reaction) => reaction.type)).toEqual(["agent"]);
  expect(check.else.map((reaction) => reaction.type)).toEqual(["wait"]);

  const yaml = patchTriggerYaml(reactionYaml, {
    ...projection.value,
    flow: ReactionFlow.update(flow, pause.id, { duration: "10m" }),
  });
  const value = TriggerDocumentSchema.parse(parseDocument(yaml).toJS());
  if (!("reactions" in value.run)) throw new Error("expected reactions");
  const wait = value.run.reactions[0];
  if (wait === undefined || !("wait" in wait)) throw new Error("expected a wait");
  expect(wait.wait.for).toBe("10m");
});

test("keeps guardrails when a reaction flow is saved from the form", () => {
  const yaml = reactionYaml.replace(
    "  reactions:",
    "  guardrails:\n    - id: slack.same_channel\n    - id: slack.same_thread\n      options: {}\n  reactions:",
  );
  const projection = projectTriggerForm(yaml);
  expect(projection.status).toBe("editable");
  if (projection.status !== "editable") throw new Error(projection.reason);
  const flow = projection.value.flow;
  const pause = flow?.[0];
  if (flow === undefined || pause?.type !== "wait") throw new Error("expected a wait");
  const saved = patchTriggerYaml(yaml, {
    ...projection.value,
    flow: ReactionFlow.update(flow, pause.id, { duration: "10m" }),
  });
  const value = TriggerDocumentSchema.parse(parseDocument(saved).toJS());
  if (!("reactions" in value.run)) throw new Error("expected reactions");
  expect(value.run.guardrails).toEqual([
    { id: "slack.same_channel" },
    { id: "slack.same_thread", options: {} },
  ]);
});

test("rejects a wait duration the form cannot store", () => {
  const projection = projectTriggerForm(reactionYaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const flow = projection.value.flow;
  const pause = flow?.[0];
  if (flow === undefined || pause?.type !== "wait") throw new Error("expected a wait");
  const errors = triggerFormErrors({
    ...projection.value,
    flow: ReactionFlow.update(flow, pause.id, { duration: "soon" }),
  });
  expect(errors["flow.pause.duration"]).toBe("Use a duration such as 30s, 5m, or 2h.");
});

const CONFIGURED = `
name: answer
enabled: true
on:
  manual.run: {}
run:
  target:
    daemon: office
    cwd: /workspace
    worktree:
      mode: branch-off
      newBranch: hub-work
      base: main
  guardrails:
    - id: slack.same_channel
    - id: slack.same_thread
      options: {}
  agent:
    provider: codex
    mode: agent
  prompt:
    - text: Handle it.
    - include: partials/safety.md
    - include:
        path: notes.md
        root: /workspace/rules
`;

test("edits guardrails, the worktree, and prompt includes in the form", () => {
  const projection = projectTriggerForm(CONFIGURED);
  expect(projection.status).toBe("editable");
  if (projection.status !== "editable") throw new Error(projection.reason);
  expect(projection.value.guardrails).toEqual([
    { id: "slack.same_channel", options: "" },
    { id: "slack.same_thread", options: "{}" },
  ]);
  expect(projection.value.worktree).toEqual({
    mode: "branch-off",
    newBranch: "hub-work",
    base: "main",
    branch: "",
    prNumber: "",
  });
  expect(projection.value.prompt).toEqual([
    { kind: "text", text: "Handle it." },
    { kind: "include", path: "partials/safety.md", root: "" },
    { kind: "include", path: "notes.md", root: "/workspace/rules" },
  ]);
  expect(patchTriggerYaml(CONFIGURED, projection.value)).toBe(CONFIGURED);

  const moved = patchTriggerYaml(CONFIGURED, { ...projection.value, cwd: "/srv/app" });
  expect(moved).toContain("include: partials/safety.md");
  expect(moved).toContain("root: /workspace/rules");
  expect(moved).toContain("id: slack.same_channel");
  expect(moved).toContain("newBranch: hub-work");
  const movedRun = singleAgentRun(TriggerDocumentSchema.parse(parseDocument(moved).toJS()).run);
  expect(movedRun.target.cwd).toBe("/srv/app");
  expect(movedRun.target.worktree).toEqual({
    mode: "branch-off",
    newBranch: "hub-work",
    base: "main",
  });
  expect(movedRun.prompt).toEqual([
    { text: "Handle it." },
    { include: "partials/safety.md" },
    { include: { path: "notes.md", root: "/workspace/rules" } },
  ]);

  const rails = patchTriggerYaml(CONFIGURED, {
    ...projection.value,
    guardrails: [{ id: "slack.same_thread", options: "" }],
  });
  expect(
    singleAgentRun(TriggerDocumentSchema.parse(parseDocument(rails).toJS()).run).guardrails,
  ).toEqual([{ id: "slack.same_thread" }]);

  const clearedRails = patchTriggerYaml(CONFIGURED, { ...projection.value, guardrails: [] });
  expect(
    singleAgentRun(TriggerDocumentSchema.parse(parseDocument(clearedRails).toJS()).run).guardrails,
  ).toBeUndefined();

  const checkedOut = patchTriggerYaml(CONFIGURED, {
    ...projection.value,
    worktree: { ...projection.value.worktree, mode: "checkout-pr", prNumber: "848" },
  });
  expect(
    singleAgentRun(TriggerDocumentSchema.parse(parseDocument(checkedOut).toJS()).run).target
      .worktree,
  ).toEqual({ mode: "checkout-pr", prNumber: 848 });

  const noTree = patchTriggerYaml(CONFIGURED, {
    ...projection.value,
    worktree: emptyWorktree(),
  });
  expect(
    singleAgentRun(TriggerDocumentSchema.parse(parseDocument(noTree).toJS()).run).target.worktree,
  ).toBeUndefined();

  const nextPrompt = patchTriggerYaml(CONFIGURED, {
    ...projection.value,
    prompt: [
      { kind: "text", text: "Handle it." },
      { kind: "include", path: "partials/review.md", root: "" },
    ],
  });
  expect(
    singleAgentRun(TriggerDocumentSchema.parse(parseDocument(nextPrompt).toJS()).run).prompt,
  ).toEqual([{ text: "Handle it." }, { include: "partials/review.md" }]);
});

test("rejects a guardrail option and an incomplete worktree in the form", () => {
  const projection = projectTriggerForm(CONFIGURED);
  if (projection.status !== "editable") throw new Error(projection.reason);
  expect(
    triggerFormErrors({
      ...projection.value,
      guardrails: [{ id: "slack.same_channel", options: '{"extra":true}' }],
    }).guardrails,
  ).toBe("This guardrail does not take those options.");
  expect(
    triggerFormErrors({
      ...projection.value,
      guardrails: [{ id: "slack.somewhere", options: "" }],
    }).guardrails,
  ).toBe("Choose a guardrail.");
  expect(
    triggerFormErrors({
      ...projection.value,
      worktree: { ...emptyWorktree(), mode: "branch-off" },
    }).worktree,
  ).toBe("New branch is required.");
  expect(
    mergeTriggerForm(CONFIGURED, {
      ...projection.value,
      guardrails: [{ id: "slack.same_channel", options: '{"extra":true}' }],
    }),
  ).toEqual({ status: "incomplete", reason: "This guardrail does not take those options." });
});

test("edits an included instruction on a reaction without a second flow", () => {
  const yaml = reactionYaml.replace(
    "            prompt: Reply.",
    "            prompt:\n              - text: Reply.\n              - include: partials/safety.md",
  );
  const projection = projectTriggerForm(yaml);
  expect(projection.status).toBe("editable");
  if (projection.status !== "editable") throw new Error(projection.reason);
  const flow = projection.value.flow;
  const agent = flow?.[1];
  if (flow === undefined || agent?.type !== "if") throw new Error("expected a condition");
  const reply = agent.then[0];
  if (reply?.type !== "agent") throw new Error("expected an agent");
  expect(reply.prompt).toEqual([
    { kind: "text", text: "Reply." },
    { kind: "include", path: "partials/safety.md", root: "" },
  ]);
  const saved = patchTriggerYaml(yaml, {
    ...projection.value,
    flow: ReactionFlow.update(flow, reply.id, {
      prompt: [{ kind: "text", text: "Reply carefully." }, ...reply.prompt.slice(1)],
    }),
  });
  const value = TriggerDocumentSchema.parse(parseDocument(saved).toJS());
  if (!("reactions" in value.run)) throw new Error("expected reactions");
  const check = value.run.reactions[1];
  if (check === undefined || !("if" in check)) throw new Error("expected a condition");
  expect(check.if.then[0]).toMatchObject({
    prompt: [{ text: "Reply carefully." }, { include: "partials/safety.md" }],
  });
});

test("writes slack_agent from the form and removes it when the surface is turned off", () => {
  const projection = projectTriggerForm(ADVANCED);
  if (projection.status !== "editable") throw new Error(projection.reason);
  expect(projection.value.slackAgent.enabled).toBe(false);
  const enabled = patchTriggerYaml(ADVANCED, {
    ...projection.value,
    slackAgent: {
      ...blankSlackAgentDraft(),
      enabled: true,
      display: "timeline",
      sessionTitle: "Pedido de hoje",
    },
  });
  expect(enabled).toContain("slack_agent:");
  expect(enabled).toContain("display: timeline");
  expect(enabled).toContain("session_title: Pedido de hoje");
  expect(enabled).not.toContain("feedback:");
  const enabledForm = projectTriggerForm(enabled);
  if (enabledForm.status !== "editable") throw new Error(enabledForm.reason);
  expect(enabledForm.value.slackAgent).toMatchObject({
    enabled: true,
    display: "timeline",
    sessionTitle: "Pedido de hoje",
  });
  const disabled = patchTriggerYaml(enabled, {
    ...enabledForm.value,
    slackAgent: { ...enabledForm.value.slackAgent, enabled: false },
  });
  expect(disabled).not.toContain("slack_agent");
  expect(patchTriggerYaml(ADVANCED, projection.value)).toBe(ADVANCED);
});

test("drops slack_agent when the trigger event is no longer Slack", () => {
  const projection = projectTriggerForm(ADVANCED);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const enabled = patchTriggerYaml(ADVANCED, {
    ...projection.value,
    slackAgent: {
      ...blankSlackAgentDraft(),
      enabled: true,
      display: "plan",
      planTitle: "A tratar",
    },
  });
  const enabledForm = projectTriggerForm(enabled);
  if (enabledForm.status !== "editable") throw new Error(enabledForm.reason);
  const moved = patchTriggerYaml(enabled, changeTriggerEvent(enabledForm.value, "manual.run"));
  expect(moved).not.toContain("slack_agent");
  const parsed = TriggerDocumentSchema.parse(parseDocument(moved).toJS());
  expect(parsed.run).not.toHaveProperty("slack_agent");
});

test("leaves a Slack agent block the form cannot represent in YAML", () => {
  const feedback = ADVANCED.replace(
    "  auto_archive: false\n",
    "  slack_agent:\n    display: plan\n    feedback: true\n  auto_archive: false\n",
  );
  const projected = projectTriggerForm(feedback);
  expect(projected.status).toBe("yaml_only");
  if (projected.status === "yaml_only") {
    expect(projected.reason).toContain(SLACK_AGENT_FEEDBACK_UNAVAILABLE);
  }
  const unknown = ADVANCED.replace(
    "  auto_archive: false\n",
    "  slack_agent:\n    display: board\n  auto_archive: false\n",
  );
  expect(projectTriggerForm(unknown).status).toBe("yaml_only");
});
