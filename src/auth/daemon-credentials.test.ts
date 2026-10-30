import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import type { DaemonRecord } from "../db/types.js";
import { DaemonTriggerAuthenticator, type DaemonTriggerLookup } from "./daemon-credentials.js";

const SECRET = "daemon-secret";

describe("daemon trigger authenticator", () => {
  it("authorizes an active daemon to install automations", async () => {
    const authenticator = new DaemonTriggerAuthenticator(lookup(daemon()));
    const result = await authenticator.authorize(request(), "configuration:install");
    assert.deepEqual(result, {
      status: "authorized",
      access: {
        kind: "daemon",
        credentialId: "daemon-1",
        organizationId: "org-1",
        scopes: ["configuration:validate", "configuration:install"],
      },
    });
  });

  it("rejects a daemon that cannot run automations", async () => {
    const authenticator = new DaemonTriggerAuthenticator(lookup(daemon({ permissions: [] })));
    const result = await authenticator.authorize(request(), "configuration:validate");
    assert.deepEqual(result, { status: "forbidden" });
  });

  it("rejects a wrong secret", async () => {
    const authenticator = new DaemonTriggerAuthenticator(lookup(daemon()));
    const result = await authenticator.authorize(
      request("Bearer wrong-secret"),
      "configuration:install",
    );
    assert.deepEqual(result, { status: "unauthorized" });
  });

  it("does not grant scopes outside trigger reads and writes", async () => {
    const authenticator = new DaemonTriggerAuthenticator(lookup(daemon()));
    const result = await authenticator.authorize(request(), "daemons:enroll");
    assert.deepEqual(result, { status: "forbidden" });
  });
});

function request(authorization = `Bearer ${SECRET}`): Request {
  return new Request("https://hub.test/api/v1/triggers", {
    headers: {
      authorization,
      "x-paseo-daemon-id": "daemon-1",
    },
  });
}

function lookup(record: DaemonRecord | undefined): DaemonTriggerLookup {
  return {
    findDaemonById: () => Promise.resolve(record),
    findMachineById: () => Promise.resolve({ orgId: "org-1" }),
  };
}

function daemon(overrides: Partial<DaemonRecord> = {}): DaemonRecord {
  return {
    id: "daemon-1",
    slug: "office",
    machineId: "machine-1",
    serverId: "server-1",
    daemonPublicKey: "key",
    credentialVerifier: createHash("sha256").update(SECRET).digest("base64url"),
    permissions: ["hub.execute"],
    registeredByApiKeyId: null,
    registeredByCliCredentialId: null,
    status: "active",
    presence: "connected",
    connectedAt: new Date("2026-10-30T00:00:00.000Z"),
    disconnectedAt: null,
    lastSeenAt: new Date("2026-10-30T00:00:00.000Z"),
    createdAt: new Date("2026-10-30T00:00:00.000Z"),
    ...overrides,
  };
}
