import { CLI_CREDENTIAL_PREFIX, OrganizationCliCredentials } from "./cli-credentials.js";
import type { OrganizationApiKeys } from "./api-keys.js";
import type { DaemonTriggerAuthenticator } from "./daemon-credentials.js";
import type { OperationAuthenticator } from "./operation-auth.js";

export class PublicCredentialAuthenticator implements OperationAuthenticator {
  constructor(
    private readonly apiKeys: OrganizationApiKeys,
    private readonly cliCredentials: OrganizationCliCredentials,
  ) {}

  authorize(request: Request, requiredScope: Parameters<OperationAuthenticator["authorize"]>[1]) {
    const authorization = request.headers.get("authorization");
    return authorization?.startsWith(`Bearer ${CLI_CREDENTIAL_PREFIX}`)
      ? this.cliCredentials.authorize(request, requiredScope)
      : this.apiKeys.authorize(request, requiredScope);
  }
}

/**
 * Public API keys, CLI credentials, and the connected daemon's trigger credential.
 *
 * A request that names a daemon is checked as that daemon. Everything else stays on the
 * existing key and CLI path.
 */
export class PublicOrDaemonAuthenticator implements OperationAuthenticator {
  constructor(
    private readonly publicCredentials: PublicCredentialAuthenticator,
    private readonly daemons: DaemonTriggerAuthenticator,
  ) {}

  /**
   * Authorizes one public API call.
   *
   * @param request - Incoming request
   * @param requiredScope - Scope the operation demands
   * @returns The authorization result
   */
  authorize(request: Request, requiredScope: Parameters<OperationAuthenticator["authorize"]>[1]) {
    const daemonId = request.headers.get("x-paseo-daemon-id")?.trim() ?? "";
    if (daemonId.length > 0) {
      return this.daemons.authorize(request, requiredScope);
    }
    return this.publicCredentials.authorize(request, requiredScope);
  }
}
