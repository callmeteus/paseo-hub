/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- each case renders one static tree */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";

import { GuardrailFields } from "./guardrail-fields.js";
import { InstructionsEditor } from "./instructions-editor.js";
import { WorktreeFields } from "./worktree-fields.js";
import { emptyWorktree, textInstructions } from "./configuration/form-drafts.js";

describe("trigger configuration fields", () => {
  it("renders a guardrail row that can be removed and a control that adds one", () => {
    const markup = renderToStaticMarkup(
      <GuardrailFields
        value={[
          { id: "slack.same_channel", options: "" },
          { id: "slack.same_thread", options: "{}" },
        ]}
        onChange={() => undefined}
      />,
    );

    assert.match(markup, /Same channel/);
    assert.match(markup, /Same thread/);
    assert.match(markup, /name="guardrail-options-1"/);
    assert.match(markup, /value="\{\}"/);
    assert.match(markup, /Add guardrail/);
    assert.match(markup, /Remove guardrail/);
  });

  it("renders the worktree mode and the inputs for the selected checkout", () => {
    const markup = renderToStaticMarkup(
      <WorktreeFields
        value={{ ...emptyWorktree(), mode: "branch-off", newBranch: "hub-work", base: "main" }}
        onChange={() => undefined}
      />,
    );

    assert.match(markup, /New branch/);
    assert.match(markup, /name="worktreeNewBranch"/);
    assert.match(markup, /value="hub-work"/);
    assert.match(markup, /name="worktreeBase"/);
    assert.match(markup, /value="main"/);
  });

  it("renders text and an included file in the instructions field", () => {
    const markup = renderToStaticMarkup(
      <InstructionsEditor
        id="trigger-prompt"
        value={[
          ...textInstructions("Handle it."),
          { kind: "include", path: "partials/safety.md", root: "" },
        ]}
        onChange={() => undefined}
      />,
    );

    assert.match(markup, /Handle it\./);
    assert.match(markup, /Instruction file/);
    assert.match(markup, /value="partials\/safety\.md"/);
    assert.match(markup, /Add instruction file/);
    assert.match(markup, /Add text/);
  });
});
