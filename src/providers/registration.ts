import type { ProjectConfigurationStore } from "../configuration/store.js";
import type { ConnectionResolutionContext, ConnectionResolver } from "../config/connections.js";
import type { OrganizationConnectionUsage } from "../db/types.js";
import type { OutputExecutor, OutputToolDefinition } from "../execution-capabilities/outputs.js";
import type { TriggerProvider, TriggerSource } from "../triggers/index.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentProvider,
  AttachmentResolver,
} from "../attachments/capabilities.js";
import type { AutomationGitSyncPort } from "../automation-sync/contract.js";
import type { SlackBotClient } from "../triggers/slack/client.js";
import type { SlackDeliveryStatus } from "../triggers/slack/source/index.js";

export interface TriggerProviderResources {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  connectionsForProject: (projectId: string) => ConnectionResolver;
  attachments?: AttachmentCapabilityRegistry;
}

export type TriggerProviderFactory = (
  resources: TriggerProviderResources,
) => TriggerProvider | undefined;

export interface ProviderIntegrationRegistration {
  resolve(
    projectId: string,
    connectionSlug: string,
    value: string,
    context?: ConnectionResolutionContext,
  ): Promise<string>;
  githubAuthority?: GitHubAuthorityRegistration;
}

export interface GitHubAuthorityRegistration {
  mint(input: {
    projectId: string;
    connectionSlug: string;
    repositories: readonly string[];
    permissions: Readonly<Record<string, "read" | "write" | "admin">>;
  }): Promise<{
    token: string;
    expiresAt: number;
    botUserId: number;
    botLogin: string;
  }>;
  revoke(token: string): Promise<void>;
}

export interface ProviderConnectionRegistration {
  name: string;
  status(connections: OrganizationConnectionUsage): unknown;
  actions: Readonly<Record<string, (request: Request) => Promise<Response>>>;
}

export interface ProviderOutputRegistration {
  type: string;
  tool: OutputToolDefinition;
  available?: (outputContext: unknown) => boolean;
  execute: OutputExecutor;
}

export interface ProviderRequestRegistration {
  name: string;
  handle(request: Request): Promise<Response>;
}

export interface ProviderAttachmentRegistration {
  provider: AttachmentProvider;
  resolve: AttachmentResolver;
}

export interface ProviderRegistration {
  configurationSnapshot?: { version: number; callbackOrigin: string };
  connection: ProviderConnectionRegistration;
  integration?: ProviderIntegrationRegistration;
  triggerProviders: readonly TriggerProviderFactory[];
  sources: readonly TriggerSource[];
  outputs: readonly ProviderOutputRegistration[];
  requests: readonly ProviderRequestRegistration[];
  attachment?: ProviderAttachmentRegistration;
  slackDelivery?: { status(): SlackDeliveryStatus; retry(): Promise<void> };
  /**
   * The Slack bot this registration already uses. Home asks it for display names.
   * Absent when Slack is not configured.
   */
  slackNames?: SlackBotClient;
  /**
   * Copies automations to GitHub. On the live registration this is the worker.
   * On the stable registration it forwards to whichever GitHub App is active.
   */
  automationSync?: AutomationGitSyncPort;
}
