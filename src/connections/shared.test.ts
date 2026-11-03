import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "vitest";
import { ProductRequestError } from "../auth/organization-access.js";
import { createLogger } from "../logger.js";
import { EmbeddedConnectionHandoff } from "./app-handoff.js";
import {
  CONNECTIONS_RETURN_ROUTE,
  connectionCallbackFailure,
  continueConnectionState,
} from "./shared.js";

class CaptureStream extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

describe("connection callback failures", () => {
  it("logs safe operator evidence and keeps the public response generic", () => {
    const stream = new CaptureStream();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";

    const response = connectionCallbackFailure({
      error: new Error(`github oauth exchange failed: 401 ${token}`),
      provider: "github",
      phase: "authorization",
      request: new Request("https://hub.test/api/integrations/github/callback?state=s&code=c", {
        headers: { cookie: "session=secret" },
      }),
      applicationBaseUrl: "https://hub.test",
      returnRoute: "/o/acme/connections",
      log: createLogger(stream),
    });

    const output = stream.text();
    assert.match(output, /connection\.callback\.authorization failed/u);
    assert.match(output, /failureKind/u);
    assert.match(output, /stack/u);
    assert.match(output, /github/u);
    assert.match(output, /authorization/u);
    assert.match(output, /"type":"Error"/u);
    assert.doesNotMatch(output, /github oauth exchange failed/u);
    assert.equal(output.includes(token), false);
    assert.equal(output.includes("session=secret"), false);
    assert.match(output, /"host":"hub.test"/u);
    assert.match(output, /"sessionCookiePresent":true/u);
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.origin + location.pathname, "https://hub.test/o/acme/connections");
    assert.equal(location.searchParams.get("app"), "github");
    assert.equal(location.searchParams.get("result"), "connection_unavailable");
    const reference = location.searchParams.get("reference");
    assert.notEqual(reference, null);
    assert.match(output, new RegExp(`"requestId":"${reference}"`, "u"));
  });

  it("names a return that reached Hub without a session, with the host it reached", () => {
    const stream = new CaptureStream();

    const response = connectionCallbackFailure({
      error: new ProductRequestError(401, "unauthenticated"),
      provider: "github",
      phase: "setup",
      request: new Request("https://hub.test/api/integrations/github/setup?state=s", {
        headers: { host: "hub.fly.example" },
      }),
      applicationBaseUrl: "https://hub.test",
      returnRoute: CONNECTIONS_RETURN_ROUTE,
      log: createLogger(stream),
    });

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "https://hub.test/connections?app=github&result=connection_unauthenticated",
    );
    const output = stream.text();
    assert.match(output, /"failureKind":"authentication"/u);
    assert.match(output, /"host":"hub.fly.example"/u);
    assert.match(output, /"sessionCookiePresent":false/u);
  });

  it("hands an embedded callback to the Paseo window instead of the signed-out landing", async () => {
    EmbeddedConnectionHandoff.reset();
    const next = continueConnectionState(
      new Request("https://hub.test/api/integrations/github/setup?state=ew.previous"),
      "ew.previous",
      "session-2",
    );
    assert.equal(next.startsWith("ew."), true);

    const response = connectionCallbackFailure({
      error: new ProductRequestError(401, "unauthenticated"),
      provider: "github",
      phase: "authorization",
      request: new Request(
        `https://hub.test/api/integrations/github/callback?state=${next}&code=c`,
        { headers: { "user-agent": "Mozilla/5.0 Chrome/120.0.0.0" } },
      ),
      applicationBaseUrl: "https://hub.test",
      returnRoute: CONNECTIONS_RETURN_ROUTE,
    });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /close this tab/u);
    assert.equal(
      EmbeddedConnectionHandoff.take("session-2"),
      `/api/integrations/github/callback?state=${next}&code=c`,
    );
    EmbeddedConnectionHandoff.reset();
  });
});
