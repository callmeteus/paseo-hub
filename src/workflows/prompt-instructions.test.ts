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
    assert.equal(prompt, "Program like this. hello\nTask hello");
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
      assert.equal(prompt, "Program like this. hello\nDo the task.");
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
