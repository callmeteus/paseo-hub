import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { compileHubConfig, isCompiledStaticStep } from "../config/compiler.js";
import {
  compileTriggerDocument,
  parseTriggerDocument,
  TriggerDocumentError,
} from "../triggers/configuration/index.js";
import { patchTriggerYaml, projectTriggerForm } from "../triggers/configuration/editor.js";
import { singleAgentRun } from "../triggers/configuration/schema.js";
import {
  composeLaunchPrompt,
  LOAD_INSTRUCTION_PROSE,
  PromptInstructionError,
  readPromptInstruction,
} from "./prompt-instructions.js";

const context = {
  prompt: "hello",
  context: null,
  inputs: {},
  steps: {},
  values: {},
};

describe("composeLaunchPrompt", () => {
  it("joins included instructions and the automation text in YAML order", async () => {
    const prompt = await composeLaunchPrompt({
      blocks: [
        { kind: "include", path: "rules/how-to-program.mdc" },
        { kind: "text", value: "Task ${{ paseo.prompt }}" },
      ],
      cwd: "/workspace",
      context,
      read: async () => "Program like this. ${{ paseo.prompt }}",
    });
    assert.equal(prompt.prompt, "Program like this. hello\nTask hello");
    assert.deepEqual(prompt.instructions, []);
  });

  it("reads an instruction from the automation directory and refuses a symlink that leaves it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hub-prompt-instructions-"));
    const outside = await mkdtemp(path.join(tmpdir(), "hub-prompt-outside-"));
    try {
      const rules = path.join(directory, ".cursor", "rules");
      await mkdir(rules, { recursive: true });
      await writeFile(
        path.join(rules, "how-to-program.mdc"),
        "Program like this. ${{ paseo.prompt }}",
        "utf8",
      );
      await writeFile(path.join(outside, "secret.mdc"), "secret", "utf8");
      await symlink(path.join(outside, "secret.mdc"), path.join(directory, "linked.mdc"));

      const prompt = await composeLaunchPrompt({
        blocks: [
          { kind: "include", path: ".cursor/rules/how-to-program.mdc" },
          { kind: "text", value: "Do the task." },
        ],
        cwd: directory,
        context,
      });
      assert.equal(prompt.prompt, "Program like this. hello\nDo the task.");
      assert.deepEqual(prompt.instructions, []);
      await assert.rejects(
        readPromptInstruction({ cwd: directory, path: "linked.mdc" }),
        /escapes its root/u,
      );
      await assert.rejects(
        readPromptInstruction({ cwd: directory, path: "../secret.mdc" }),
        /instruction path must not contain empty, '.' or '..' segments/u,
      );
      await assert.rejects(
        readPromptInstruction({ cwd: directory, path: "missing.mdc" }),
        (error: unknown) => error instanceof PromptInstructionError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reads a declared root, including a home-relative root", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hub-prompt-root-"));
    try {
      await writeFile(path.join(directory, "how-to-program.mdc"), "Shared rule.", "utf8");
      const text = await readPromptInstruction({
        cwd: "/unused",
        path: "how-to-program.mdc",
        root: directory,
      });
      assert.equal(text, "Shared rule.");
      const marker = `hub-missing-instruction-${path.basename(directory)}`;
      await assert.rejects(
        readPromptInstruction({ cwd: directory, path: "how.mdc", root: `~/${marker}` }),
        (error: unknown) => {
          assert.ok(error instanceof PromptInstructionError);
          assert.equal(error.message.includes(homedir()), true);
          assert.equal(error.message.includes(marker), true);
          return true;
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const LIVE_CATALOG_LINES = [
  "ajuste-de-saldo.md — Use este arquivo só quando o pedido, em #tecnologia-triagem, for um ajuste de saldo, ou quando a pessoa estiver confirmando um plano de ajuste que você já publicou nessa thread. Em #tecnologia-operações-luckyops, não faça ajuste de saldo.",
  "alteracao-de-infra.md — Use este arquivo quando o pedido for uma alteração de infraestrutura, ou quando a pessoa estiver confirmando um plano de infraestrutura que você já publicou nessa thread. Vale em #tecnologia-operações-luckyops e em #tecnologia-triagem. Ajuste de saldo não é este arquivo.",
  "rastro-de-banco.md — Leia este arquivo antes de qualquer gravação no banco. Sem este rastro, a gravação não acontece.",
];

describe("instruction catalogs", () => {
  it("keeps the current regras sentences whole", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hub-instruction-catalog-"));
    try {
      for (const line of LIVE_CATALOG_LINES) {
        const [name, sentence] = line.split(" — ");
        await writeFile(
          path.join(directory, name ?? ""),
          `${sentence}\nO corpo fica de fora.\n`,
          "utf8",
        );
      }
      const prompt = await composeLaunchPrompt({
        blocks: [{ kind: "load", root: directory }],
        cwd: "/workspace",
        context,
      });
      for (const line of LIVE_CATALOG_LINES) assert.equal(prompt.prompt.includes(line), true);
      assert.equal(prompt.prompt.includes("O corpo fica de fora."), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("injects the English index in place of load and keeps the file body out", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hub-instruction-catalog-"));
    try {
      await writeFile(
        path.join(directory, "ajuste-de-saldo.md"),
        "---\nwhen: ajuste de saldo ${{ paseo.prompt }}\n---\nBODY_SENTINEL_SHOULD_STAY_OUT\n",
        "utf8",
      );
      await writeFile(
        path.join(directory, "alteracao-de-infra.md"),
        `${"a".repeat(450)}\nThe rest of the infra rule.\n`,
        "utf8",
      );
      await writeFile(path.join(directory, "notes.txt"), "not a catalog file", "utf8");
      const prompt = await composeLaunchPrompt({
        blocks: [
          { kind: "text", value: "Task ${{ paseo.prompt }}" },
          { kind: "load", root: directory },
          { kind: "text", value: "Keep ${{ paseo.prompt }} out of the catalog line." },
        ],
        cwd: "/workspace",
        context,
      });
      assert.equal(
        prompt.prompt,
        [
          "Task hello",
          LOAD_INSTRUCTION_PROSE,
          "",
          "- ajuste-de-saldo.md — ajuste de saldo ${{ paseo.prompt }}",
          `- alteracao-de-infra.md — ${"a".repeat(400)}`,
          "Keep hello out of the catalog line.",
        ].join("\n"),
      );
      assert.equal(prompt.prompt.includes("BODY_SENTINEL_SHOULD_STAY_OUT"), false);
      assert.equal(prompt.prompt.includes("The rest of the infra rule."), false);
      assert.deepEqual(prompt.instructions, [
        { path: "ajuste-de-saldo.md", root: directory },
        { path: "alteracao-de-infra.md", root: directory },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses an empty catalog, a repeated path, and a symlink that leaves the root", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hub-instruction-catalog-"));
    const outside = await mkdtemp(path.join(tmpdir(), "hub-instruction-outside-"));
    const empty = await mkdtemp(path.join(tmpdir(), "hub-instruction-empty-"));
    const repeated = await mkdtemp(path.join(tmpdir(), "hub-instruction-repeated-"));
    try {
      await writeFile(path.join(directory, "ajuste-de-saldo.md"), "Ajuste de saldo.\n", "utf8");
      await writeFile(path.join(outside, "secret.md"), "secret", "utf8");
      await symlink(path.join(outside, "secret.md"), path.join(directory, "secret.md"));
      await writeFile(path.join(repeated, "ajuste-de-saldo.md"), "Ajuste de saldo.\n", "utf8");
      await assert.rejects(
        composeLaunchPrompt({
          blocks: [{ kind: "load", root: directory }],
          cwd: "/workspace",
          context,
        }),
        /escapes its root/u,
      );
      await assert.rejects(
        composeLaunchPrompt({
          blocks: [
            { kind: "load", root: repeated },
            { kind: "load", root: repeated },
          ],
          cwd: "/workspace",
          context,
        }),
        /instruction catalog path is repeated: ajuste-de-saldo.md/u,
      );
      await assert.rejects(
        composeLaunchPrompt({
          blocks: [{ kind: "load", root: empty }],
          cwd: "/workspace",
          context,
        }),
        /instruction catalog is empty/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      await rm(empty, { recursive: true, force: true });
      await rm(repeated, { recursive: true, force: true });
    }
  });
});

describe("automation prompt includes", () => {
  it("compiles explicit includes and edits them in the form", () => {
    const yaml = `
name: answer
enabled: true
on:
  slack.mention:
    connection: slack-office
    filters:
      from_users: ["*"]
run:
  target:
    daemon: office
    cwd: /workspace
    worktree:
      mode: branch-off
      newBranch: auto-\${{ paseo.execution.id }}
  agent:
    provider: cursor
    mode: agent
  prompt:
    - include: .cursor/rules/how-to-program.mdc
    - include:
        path: how-to-program.mdc
        root: ~/.cursor/rules
    - text: |
        Answer the request.
        \${{ paseo.prompt }}
`;
    const parsed = parseTriggerDocument(yaml);
    const run = singleAgentRun(parsed.run);
    assert.deepEqual(run.prompt, [
      { include: ".cursor/rules/how-to-program.mdc" },
      { include: { path: "how-to-program.mdc", root: "~/.cursor/rules" } },
      { text: "Answer the request.\n${{ paseo.prompt }}\n" },
    ]);
    const compiled = compileTriggerDocument(yaml);
    const step = compiled.events[0]?.steps[0];
    if (step === undefined || isCompiledStaticStep(step)) {
      throw new Error("expected an agent step");
    }
    assert.deepEqual(step.prompt, [
      { kind: "include", path: ".cursor/rules/how-to-program.mdc" },
      { kind: "include", path: "how-to-program.mdc", root: "~/.cursor/rules" },
      { kind: "text", value: "Answer the request.\n${{ paseo.prompt }}\n" },
    ]);
    assert.deepEqual(
      compiled.environment.kind === "daemon" ? compiled.environment.worktree : undefined,
      {
        mode: "branch-off",
        newBranch: "auto-${{ paseo.execution.id }}",
      },
    );
    const projection = projectTriggerForm(yaml);
    assert.equal(projection.status, "editable");
    if (projection.status !== "editable") return;
    assert.deepEqual(projection.value.prompt, [
      { kind: "include", path: ".cursor/rules/how-to-program.mdc", root: "" },
      { kind: "include", path: "how-to-program.mdc", root: "~/.cursor/rules" },
      { kind: "text", text: "Answer the request.\n${{ paseo.prompt }}\n" },
    ]);
    assert.equal(projection.value.worktree.mode, "branch-off");
    assert.equal(projection.value.worktree.newBranch, "auto-${{ paseo.execution.id }}");
    assert.equal(patchTriggerYaml(yaml, projection.value), yaml);
    const saved = patchTriggerYaml(yaml, { ...projection.value, cwd: "/srv/app" });
    const savedRun = singleAgentRun(parseTriggerDocument(saved).run);
    assert.equal(savedRun.target.cwd, "/srv/app");
    assert.deepEqual(savedRun.prompt, run.prompt);
    assert.deepEqual(savedRun.target.worktree, {
      mode: "branch-off",
      newBranch: "auto-${{ paseo.execution.id }}",
    });
  });

  it("keeps a string prompt on the form and refuses a workflow include that has no bundle", () => {
    const yaml = `
name: answer
enabled: true
on:
  slack.mention:
    connection: slack-office
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
`;
    assert.equal(projectTriggerForm(yaml).status, "editable");
    assert.throws(
      () =>
        compileHubConfig({
          environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
          triggers: [
            {
              name: "run",
              on: "manual.run",
              max_runtime: "1h",
              steps: [
                {
                  id: "run",
                  environment: "runner",
                  max_runtime: "10m",
                  idle_timeout: "1m",
                  agent: { provider: "codex" },
                  prompt: [{ include: ".cursor/rules/how.mdc" }],
                },
              ],
            },
          ],
        }),
      /prompt partial bundle/u,
    );
  });

  it("keeps a load catalog in the form and compiles it without reading the directory", () => {
    const yaml = `
name: answer
enabled: true
on:
  slack.mention:
    connection: slack-office
    filters:
      from_users: ["*"]
run:
  target:
    daemon: office
    cwd: /workspace
  agent:
    provider: cursor
    mode: agent
  prompt:
    - include:
        path: partials/falar.md
        root: ~/.paseo/automations
    - load:
        root: ~/.paseo/automations/regras
    - text: |
        Seu nome é Patchy.
`;
    const parsed = parseTriggerDocument(yaml);
    const run = singleAgentRun(parsed.run);
    assert.deepEqual(run.prompt, [
      { include: { path: "partials/falar.md", root: "~/.paseo/automations" } },
      { load: { root: "~/.paseo/automations/regras" } },
      { text: "Seu nome é Patchy.\n" },
    ]);
    const compiled = compileTriggerDocument(yaml);
    const step = compiled.events[0]?.steps[0];
    if (step === undefined || isCompiledStaticStep(step)) {
      throw new Error("expected an agent step");
    }
    assert.deepEqual(step.prompt, [
      { kind: "include", path: "partials/falar.md", root: "~/.paseo/automations" },
      { kind: "load", root: "~/.paseo/automations/regras" },
      { kind: "text", value: "Seu nome é Patchy.\n" },
    ]);
    const projection = projectTriggerForm(yaml);
    assert.equal(projection.status, "editable");
    if (projection.status !== "editable") return;
    assert.deepEqual(projection.value.prompt, [
      { kind: "include", path: "partials/falar.md", root: "~/.paseo/automations" },
      { kind: "load", root: "~/.paseo/automations/regras" },
      { kind: "text", text: "Seu nome é Patchy.\n" },
    ]);
    const saved = patchTriggerYaml(yaml, projection.value);
    assert.deepEqual(singleAgentRun(parseTriggerDocument(saved).run).prompt, run.prompt);
    const bundled = compileHubConfig({
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "run",
          on: "manual.run",
          max_runtime: "1h",
          steps: [
            {
              id: "run",
              environment: "runner",
              max_runtime: "10m",
              idle_timeout: "1m",
              agent: { provider: "codex" },
              prompt: [{ load: { root: "/workspace/regras" } }],
            },
          ],
        },
      ],
    });
    const bundledStep = bundled.triggers[0]?.steps[0];
    if (bundledStep === undefined || isCompiledStaticStep(bundledStep)) {
      throw new Error("expected an agent step");
    }
    assert.deepEqual(bundledStep.prompt, [{ kind: "load", root: "/workspace/regras" }]);
    assert.throws(
      () =>
        compileTriggerDocument(`
name: answer
on:
  manual.run: {}
run:
  target: { daemon: office, cwd: /workspace }
  agent: { provider: codex }
  prompt:
    - load:
        root: regras
`),
      /absolute path/u,
    );
  });

  it("rejects a prompt list that has no instructions", () => {
    assert.throws(
      () =>
        parseTriggerDocument(`
name: answer
on:
  manual.run: {}
run:
  target: { daemon: office, cwd: /workspace }
  agent: { provider: codex }
  prompt:
    - text: "  "
`),
      (error: unknown) => error instanceof TriggerDocumentError,
    );
  });
});
