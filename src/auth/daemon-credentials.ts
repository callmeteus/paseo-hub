import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiKeyScope } from "./api-key-contract.js";
import type { OperationAuthorizationResult } from "./api-keys.js";
import type { DaemonRecord } from "../db/types.js";

const TRIGGER_SCOPES = new Set<ApiKeyScope>(["configuration:validate", "configuration:install"]);

/** The daemon lookup the trigger authenticator needs. */
export interface DaemonTriggerLookup {
  findDaemonById(id: string): Promise<DaemonRecord | undefined>;
  findMachineById(id: string): Promise<{ orgId: string } | undefined>;
}

/**
 * Authorizes a connected daemon to list and save automations.
 *
 * The daemon sends its id in `x-paseo-daemon-id` and its enrollment secret as a bearer token.
 * Only `configuration:validate` and `configuration:install` are granted, and only when the
 * daemon is active and allowed to run automations.
 */
export class DaemonTriggerAuthenticator {
  constructor(private readonly daemons: DaemonTriggerLookup) {}

  /**
   * Accepts the daemon credential for trigger reads and writes.
   *
   * @param request - Public API request
   * @param requiredScope - Scope the operation demands
   * @returns Authorization for that daemon's organization, or a refusal
   */
  async authorize(
    request: Request,
    requiredScope: ApiKeyScope,
  ): Promise<OperationAuthorizationResult> {
    const daemonId = request.headers.get("x-paseo-daemon-id")?.trim() ?? "";
    const credential = bearer(request.headers.get("authorization"));
    if (daemonId.length === 0 || credential === undefined) {
      return { status: "unauthorized" };
    }

    const daemon = await this.daemons.findDaemonById(daemonId);
    if (
      daemon === undefined ||
      daemon.status !== "active" ||
      !matchesVerifier(credential, daemon.credentialVerifier)
    ) {
      return { status: "unauthorized" };
    }

    if (!TRIGGER_SCOPES.has(requiredScope) || !daemon.permissions.includes("hub.execute")) {
      return { status: "forbidden" };
    }

    const machine = await this.daemons.findMachineById(daemon.machineId);
    if (machine === undefined) {
      return { status: "unauthorized" };
    }

    return {
      status: "authorized",
      access: {
        kind: "daemon",
        credentialId: daemon.id,
        organizationId: machine.orgId,
        scopes: ["configuration:validate", "configuration:install"],
      },
    };
  }
}

/**
 * Reads the bearer token.
 *
 * @param value - Authorization header
 * @returns The token, or undefined when the header is not a bearer token
 */
function bearer(value: string | null): string | undefined {
  if (value === null || !value.startsWith("Bearer ")) {
    return undefined;
  }
  const token = value.slice("Bearer ".length);
  return token.length === 0 ? undefined : token;
}

/**
 * Compares a presented secret with the stored verifier.
 *
 * @param value - Secret from the request
 * @param expectedVerifier - SHA-256 verifier stored for the daemon
 * @returns Whether the secret matches
 */
function matchesVerifier(value: string, expectedVerifier: string): boolean {
  const actual = createHash("sha256").update(value).digest("base64url");
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expectedVerifier);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
