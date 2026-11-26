import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  parseConfiguredConnections,
  ProviderConnectionConfigurationError,
  readConfiguredConnections,
} from "./environment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider connections declared by the environment", () => {
  it("is off when neither variable is set", async () => {
    assert.deepEqual(await readConfiguredConnections({}), []);
    assert.deepEqual(
      await readConfiguredConnections({
        PASEO_HUB_CONNECTIONS: "   ",
        PASEO_HUB_CONNECTIONS_FILE: "",
      }),
      [],
    );
  });

  it("reads the inline declaration and normalizes Telegram chat ids", async () => {
    const connections = await readConfiguredConnections({
      PASEO_HUB_CONNECTIONS: JSON.stringify({
        connections: [
          { provider: "slack", organization: "acme", botToken: "xoxb-acme" },
          { provider: "telegram", organization: "acme", chats: [-100200, -100200, "-100300"] },
        ],
      }),
    });
    assert.deepEqual(connections, [
      { provider: "slack", organization: "acme", botToken: "xoxb-acme" },
      { provider: "telegram", organization: "acme", chats: ["-100200", "-100300"] },
    ]);
  });

  it("normalizes a declared GitHub installation and keeps an optional slug", () => {
    assert.deepEqual(
      parseConfiguredConnections({
        connections: [
          { provider: "github", organization: "acme", installationId: 178294978 },
          {
            provider: "github",
            organization: "acme",
            installationId: "178294979",
            slug: "acme-app",
          },
        ],
      }),
      [
        { provider: "github", organization: "acme", installationId: "178294978" },
        {
          provider: "github",
          organization: "acme",
          installationId: "178294979",
          slug: "acme-app",
        },
      ],
    );
  });

  it("refuses a GitHub declaration without an installation or with an unusable slug", () => {
    for (const entry of [
      { provider: "github", organization: "acme" },
      { provider: "github", organization: "acme", installationId: 0 },
      { provider: "github", organization: "acme", installationId: "abc" },
      { provider: "github", organization: "acme", installationId: "1", slug: "Acme App" },
    ]) {
      assert.throws(
        () => parseConfiguredConnections({ connections: [entry] }),
        ProviderConnectionConfigurationError,
      );
    }
  });

  it("reads the same document from a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-provider-connections-"));
    roots.push(root);
    const file = join(root, "connections.json");
    await writeFile(
      file,
      JSON.stringify({
        connections: [{ provider: "telegram", organization: "acme", chats: ["-1"] }],
      }),
    );
    assert.deepEqual(await readConfiguredConnections({ PASEO_HUB_CONNECTIONS_FILE: file }), [
      { provider: "telegram", organization: "acme", chats: ["-1"] },
    ]);
  });

  it("refuses an inline value and a file at the same time", async () => {
    await assert.rejects(
      readConfiguredConnections({
        PASEO_HUB_CONNECTIONS: '{"connections":[]}',
        PASEO_HUB_CONNECTIONS_FILE: "/tmp/connections.json",
      }),
      ProviderConnectionConfigurationError,
    );
  });

  it("refuses a declaration it cannot apply instead of skipping it", () => {
    for (const document of [
      "{not json",
      JSON.stringify({}),
      JSON.stringify({ connections: [{ provider: "slack", organization: "acme" }] }),
      JSON.stringify({ connections: [{ provider: "telegram", organization: "acme", chats: [] }] }),
      JSON.stringify({ connections: [{ provider: "discord", organization: "acme" }] }),
      JSON.stringify({ connections: [{ provider: "slack", organization: "", botToken: "x" }] }),
    ]) {
      assert.throws(
        () => parseConfiguredConnections(document),
        ProviderConnectionConfigurationError,
      );
    }
  });

  it("ignores an unknown field so a typo cannot pass as configuration", () => {
    assert.throws(
      () =>
        parseConfiguredConnections({
          connections: [
            { provider: "slack", organization: "acme", botToken: "xoxb", workspace: "acme" },
          ],
        }),
      ProviderConnectionConfigurationError,
    );
  });
});
