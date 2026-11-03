import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { connectionAttemptFinished } from "./handoff-watch.js";

describe("connection handoff watch", () => {
  it("finishes only when the return appears after the attempt left", () => {
    assert.equal(connectionAttemptFinished("?app=github&result=github_connected", ""), true);
  });

  it("keeps waiting when the page already showed an older return", () => {
    const search = "?app=github&result=connection_unauthenticated";
    assert.equal(connectionAttemptFinished(search, search), false);
    assert.equal(connectionAttemptFinished("", ""), false);
  });
});
