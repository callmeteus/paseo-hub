import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { planAutomationTree } from "./tree.js";

describe("automation tree plan", () => {
  it("updates managed files and deletes the ones that left, leaving the rest of the repo", () => {
    const changes = planAutomationTree(
      [
        { path: "README.md", sha: "readme" },
        { path: ".paseo/automations/partials/falar.md", sha: "same" },
        { path: ".paseo/triggers/old.yml", sha: "old" },
      ],
      [
        { path: ".paseo/automations/partials/falar.md", sha: "same", content: "same" },
        { path: ".paseo/automations/regras/nova.md", sha: "new", content: "nova" },
        { path: ".paseo/triggers/triagem.yml", sha: "yaml", content: "name: triagem\n" },
      ],
    );
    assert.deepEqual(changes, [
      { path: ".paseo/triggers/old.yml", mode: "100644", type: "blob", sha: null },
      { path: ".paseo/automations/regras/nova.md", mode: "100644", type: "blob", content: "nova" },
      {
        path: ".paseo/triggers/triagem.yml",
        mode: "100644",
        type: "blob",
        content: "name: triagem\n",
      },
    ]);
  });

  it("makes no commit when the managed files already match", () => {
    assert.deepEqual(
      planAutomationTree(
        [{ path: ".paseo/triggers/triagem.yml", sha: "yaml" }],
        [{ path: ".paseo/triggers/triagem.yml", sha: "yaml", content: "name: triagem\n" }],
      ),
      [],
    );
  });
});
