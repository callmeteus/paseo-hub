import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { EmbeddedConnectionHandoff } from "./app-handoff.js";

const STATE = "ew.install-state";
const SESSION = "session-1";

describe("embedded connection handoff", () => {
  afterEach(() => {
    EmbeddedConnectionHandoff.reset();
  });

  it("parks a signed-out browser callback for the session that started it", async () => {
    EmbeddedConnectionHandoff.remember(STATE, SESSION);
    const request = callbackRequest(STATE, "Mozilla/5.0 Chrome/120.0.0.0");

    assert.equal(EmbeddedConnectionHandoff.park(request), true);
    assert.equal(EmbeddedConnectionHandoff.take("someone-else"), null);

    const path = EmbeddedConnectionHandoff.take(SESSION);
    assert.equal(
      path,
      "/api/integrations/github/setup?state=ew.install-state&setup_action=install&installation_id=42",
    );
    assert.equal(EmbeddedConnectionHandoff.take(SESSION), null);

    const page = EmbeddedConnectionHandoff.page();
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/u);
    assert.match(await page.text(), /close this tab/u);
    assert.equal(page.headers.get("location"), null);
  });

  it("does not park a callback the Paseo window is already loading", () => {
    EmbeddedConnectionHandoff.remember(STATE, SESSION);

    assert.equal(
      EmbeddedConnectionHandoff.park(callbackRequest(STATE, "Mozilla/5.0 Electron/33.0.0")),
      false,
    );
    assert.equal(EmbeddedConnectionHandoff.take(SESSION), null);
  });

  it("does not park an expired attempt or a state Hub did not remember", () => {
    EmbeddedConnectionHandoff.remember(STATE, SESSION, Date.now() - 1);

    assert.equal(
      EmbeddedConnectionHandoff.park(callbackRequest(STATE, "Mozilla/5.0 Chrome/120.0.0.0")),
      false,
    );
    assert.equal(
      EmbeddedConnectionHandoff.park(callbackRequest("ew.unknown", "Mozilla/5.0 Chrome/120.0.0.0")),
      false,
    );
    assert.equal(EmbeddedConnectionHandoff.take(SESSION), null);
  });
});

function callbackRequest(state: string, userAgent: string): Request {
  return new Request(
    `https://hub.test/api/integrations/github/setup?state=${state}&setup_action=install&installation_id=42`,
    { headers: { "user-agent": userAgent } },
  );
}
