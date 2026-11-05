import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createSlackConnectionClient, hasSlackDispatchScopes } from "./client.js";

describe("Slack connection client", () => {
  it("accepts a workspace that can reply but cannot list channels", () => {
    assert.equal(
      hasSlackDispatchScopes([
        "app_mentions:read",
        "channels:history",
        "chat:write",
        "files:read",
        "groups:history",
        "reactions:write",
        "users:read",
      ]),
      true,
    );
  });

  it("rejects a workspace that cannot post a reply", () => {
    assert.equal(
      hasSlackDispatchScopes([
        "app_mentions:read",
        "channels:history",
        "files:read",
        "groups:history",
        "users:read",
      ]),
      false,
    );
  });

  it("builds the minimal OAuth grant and validates the installation identity", async () => {
    let exchangeBody: URLSearchParams | undefined;
    const client = createSlackConnectionClient({
      appId: "A1",
      clientId: "client-1",
      clientSecret: "secret-1",
      publicBaseUrl: "https://hub.test",
      fetch: async (input, init) => {
        let inputUrl: string;
        if (typeof input === "string") inputUrl = input;
        else if (input instanceof URL) inputUrl = input.href;
        else inputUrl = input.url;
        if (inputUrl.endsWith("/auth.test")) {
          return Response.json({ ok: true, team_id: "T1", user_id: "UBOT" });
        }
        if (init?.body instanceof URLSearchParams) exchangeBody = init.body;
        return Response.json({
          ok: true,
          app_id: "A1",
          access_token: "xoxb-token",
          bot_user_id: "UBOT",
          scope:
            "app_mentions:read,assistant:write,channels:history,channels:read,chat:write,files:read,groups:history,groups:read,reactions:write,users:read",
          team: { id: "T1", name: "Acme" },
        });
      },
    });
    const authorization = new URL(client.authorizationUrl("random-state"));
    assert.equal(authorization.origin, "https://slack.com");
    assert.equal(authorization.pathname, "/oauth/v2/authorize");
    assert.equal(authorization.searchParams.get("state"), "random-state");
    assert.equal(
      authorization.searchParams.get("scope"),
      "app_mentions:read,assistant:write,channels:history,channels:read,chat:write,files:read,groups:history,groups:read,reactions:write,users:read",
    );
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      "https://hub.test/api/integrations/slack/callback",
    );
    const installation = await client.exchangeCode("code-1");
    assert.deepEqual(installation, {
      appId: "A1",
      teamId: "T1",
      teamName: "Acme",
      botUserId: "UBOT",
      botAccessToken: "xoxb-token",
      scopes: [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:read",
        "chat:write",
        "files:read",
        "groups:history",
        "groups:read",
        "reactions:write",
        "users:read",
      ],
    });
    await client.verifyInstallation(installation);
    assert.equal(exchangeBody?.get("client_secret"), "secret-1");
    assert.equal(
      exchangeBody?.get("redirect_uri"),
      "https://hub.test/api/integrations/slack/callback",
    );
  });

  it("rejects an OAuth response for a different app", async () => {
    const client = createSlackConnectionClient({
      appId: "A1",
      clientId: "client-1",
      clientSecret: "secret-1",
      publicBaseUrl: "https://hub.test",
      fetch: () =>
        Promise.resolve(
          Response.json({
            ok: true,
            app_id: "A2",
            access_token: "xoxb-token",
            bot_user_id: "UBOT",
            team: { id: "T1", name: "Acme" },
          }),
        ),
    });
    await assert.rejects(() => client.exchangeCode("code-1"), /invalid installation/u);
  });

  it("rejects a bot token that does not act as the installed bot", async () => {
    const client = createSlackConnectionClient({
      appId: "A1",
      clientId: "client-1",
      clientSecret: "secret-1",
      publicBaseUrl: "https://hub.test",
      fetch: () => Promise.resolve(Response.json({ ok: true, team_id: "T2", user_id: "UBOT" })),
    });
    await assert.rejects(
      () =>
        client.verifyInstallation({
          appId: "A1",
          teamId: "T1",
          teamName: "Acme",
          botUserId: "UBOT",
          botAccessToken: "xoxb-token",
          scopes: [],
        }),
      /verification failed/u,
    );
  });
});
