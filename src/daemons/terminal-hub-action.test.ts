import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { terminalHubAction } from "./terminal-hub-action.js";

const worktree = { mode: "branch-off" as const, newBranch: "auto-run" };

describe("terminalHubAction", () => {
  it("leaves a run that did not ask for a worktree on the working directory", () => {
    const execution = {
      daemonId: "daemon-1",
      launchIntent: { autoArchive: false, environment: {} },
    };
    assert.equal(terminalHubAction(execution, "succeeded"), null);
    assert.equal(terminalHubAction(execution, "failed"), "interrupt");
  });

  it("still archives a run that asked to auto-archive and did not name a worktree", () => {
    const execution = {
      daemonId: "daemon-1",
      launchIntent: { autoArchive: true, environment: {} },
    };
    assert.equal(terminalHubAction(execution, "succeeded"), "archive");
    assert.equal(terminalHubAction(execution, "failed"), "archive");
  });

  it("archives a worktree run on success and on failure even when auto-archive is off", () => {
    const execution = {
      daemonId: "daemon-1",
      launchIntent: { autoArchive: false, environment: { worktree } },
    };
    assert.equal(terminalHubAction(execution, "succeeded"), "archive");
    assert.equal(terminalHubAction(execution, "failed"), "archive");
  });

  it("does not archive when no daemon owns the run", () => {
    const execution = {
      daemonId: null,
      launchIntent: { autoArchive: false, environment: { worktree } },
    };
    assert.equal(terminalHubAction(execution, "failed"), null);
  });
});
