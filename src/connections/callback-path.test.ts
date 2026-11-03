import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isConnectionCallbackPath, isEmbeddedConnectionState } from "./callback-path.js";

describe("connection callback paths", () => {
  it("accepts a GitHub install callback and an embedded state", () => {
    assert.equal(
      isConnectionCallbackPath(
        "/api/integrations/github/setup?state=ew.token&setup_action=install&installation_id=42",
      ),
      true,
    );
    assert.equal(isEmbeddedConnectionState("ew.token"), true);
  });

  it("rejects a state that was not started in Paseo and a path that is not a callback", () => {
    assert.equal(isEmbeddedConnectionState("token"), false);
    assert.equal(isConnectionCallbackPath("/connections?app=github"), false);
    assert.equal(isConnectionCallbackPath("https://github.com/login"), false);
    assert.equal(isConnectionCallbackPath("//github.com/login"), false);
  });
});
