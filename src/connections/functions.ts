import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { handleConnections } from "../server/runtime.js";
import {
  CONNECTION_PROVIDERS,
  connectionProviderName,
  type ConnectionProvider,
} from "./result-contract.js";

export type { ConnectionProvider } from "./result-contract.js";

const githubStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({
    status: z.enum(["connected", "suspended"]),
  }),
]);
const discordStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({
    status: z.literal("connected"),
  }),
]);
const slackStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("requiresReauthorization") }),
  z.object({
    status: z.literal("connected"),
  }),
]);
const linearStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("requiresReauthorization") }),
  z.object({ status: z.literal("connected") }),
]);
export const connectionStatusSchema = z.object({
  canManage: z.boolean(),
  github: githubStatusSchema,
  discord: discordStatusSchema,
  slack: slackStatusSchema,
  linear: linearStatusSchema,
});
const scopeSchema = z.object({
  organizationSlug: z.string().min(1),
  projectSlug: z.string().min(1).optional(),
});
const providerSchema = scopeSchema.extend({
  provider: z.enum(CONNECTION_PROVIDERS),
});
const disconnectSchema = providerSchema.extend({ connectionId: z.string().uuid() });
const reauthorizeSlackSchema = z.object({
  organizationSlug: z.string().min(1),
  connectionId: z.string().uuid(),
});
const startSchema = z.object({ url: z.string().url() });
const reauthorizeSlackResultSchema = z.union([
  z.object({ url: z.string().url() }),
  z.object({ complete: z.boolean(), teamName: z.string() }),
]);

export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type ConnectionDisconnectResult = `${ConnectionProvider}_disconnected`;
export type SlackReauthorizeResult = z.infer<typeof reauthorizeSlackResultSchema>;

const handoffSchema = z.object({ path: z.string().nullable() });

/**
 * Reads the provider callback the system browser parked for this session.
 *
 * @returns The callback path, or null when nothing is waiting.
 */
export const takeConnectionHandoff = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<{ path: string | null }>> => {
    try {
      const incoming = getRequest();
      const headers = new Headers(incoming.headers);
      headers.delete("content-length");
      const response = await handleConnections(
        new Request(new URL("/connections/handoff", incoming.url), {
          method: "POST",
          headers,
          body: "{}",
        }),
        "handoff",
      );
      if (!response.ok) {
        return respondOk({ path: null });
      }
      return respondOk(handoffSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(
        error,
        { operation: "connection.handoff", component: "connections" },
        {
          fallback: "Hub couldn't check for a connection to finish.",
        },
      );
    }
  },
);

export const connectionStatus = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<Result<ConnectionStatus>> => {
    try {
      const response = await handleConnections(
        operationRequest("GET", "/connections", data),
        "status",
      );
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.status",
          response,
          "Hub couldn't load this organization's connections. Reload the page.",
          data,
        );
      }
      return respondOk(connectionStatusSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.status", data), {
        fallback: "Hub couldn't load this organization's connections. Reload the page.",
      });
    }
  });

export const startConnection = createServerFn({ method: "POST" })
  .validator(providerSchema)
  .handler(async ({ data }): Promise<Result<{ url: string }>> => {
    const name = connectionProviderName(data.provider);
    try {
      const operation = CONNECTION_OPERATIONS[data.provider].start;
      const response = await handleConnections(
        operationRequest("POST", "/connections/start", data),
        operation,
      );
      if (response.status === 403) {
        return connectionResponseFailure(
          "connection.start",
          response,
          `You don't have permission to start ${name}.`,
          data,
        );
      }
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.start",
          response,
          `Hub couldn't start the ${name} connection. Check the app status and provider availability before starting again.`,
          data,
        );
      }
      return respondOk(startSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.start", data), {
        fallback: `Hub couldn't start the ${name} connection. Check the app status and provider availability before starting again.`,
      });
    }
  });

export const disconnectConnection = createServerFn({ method: "POST" })
  .validator(disconnectSchema)
  .handler(async ({ data }): Promise<Result<{ result: ConnectionDisconnectResult }>> => {
    const name = connectionProviderName(data.provider);
    try {
      const operation = CONNECTION_OPERATIONS[data.provider].disconnect;
      const response = await handleConnections(
        operationRequest("POST", "/connections/disconnect", data, data.connectionId),
        operation,
      );
      if (response.status === 403) {
        return connectionResponseFailure(
          "connection.disconnect",
          response,
          `You don't have permission to disconnect ${name}.`,
          data,
        );
      }
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.disconnect",
          response,
          `Hub couldn't disconnect ${name}. Reload its connection status before disconnecting again.`,
          data,
        );
      }
      return respondOk({ result: `${data.provider}_disconnected` as const });
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.disconnect", data), {
        fallback: `Hub couldn't disconnect ${name}. Reload its connection status before disconnecting again.`,
      });
    }
  });

export const reauthorizeSlackConnection = createServerFn({ method: "POST" })
  .validator(reauthorizeSlackSchema)
  .handler(async ({ data }): Promise<Result<SlackReauthorizeResult>> => {
    try {
      const response = await handleConnections(
        operationRequest("POST", "/connections/reauthorize", data, data.connectionId),
        "slackReauthorize",
      );
      if (!response.ok) {
        const body = z
          .object({ error: z.string().optional() })
          .safeParse(await response.json().catch(() => undefined));
        return connectionResponseFailure(
          "connection.reauthorize",
          response,
          slackReauthorizeFailure(body.success ? body.data.error : undefined, response.status),
          data,
        );
      }
      return respondOk(reauthorizeSlackResultSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.reauthorize", data), {
        fallback: "Hub couldn't reauthorize Slack. Try again.",
      });
    }
  });

const CONNECTION_OPERATIONS = {
  github: { start: "githubStart", disconnect: "githubDisconnect" },
  discord: { start: "discordStart", disconnect: "discordDisconnect" },
  slack: { start: "slackStart", disconnect: "slackDisconnect" },
  linear: { start: "linearStart", disconnect: "linearDisconnect" },
} as const;

function slackReauthorizeFailure(code: unknown, status: number): string {
  if (code === "credentials_rejected") {
    return "Slack rejected the saved bot token. Replace the credentials, then try again.";
  }
  if (code === "workspace_mismatch") {
    return "The saved bot token belongs to a different Slack workspace.";
  }
  if (code === "not_found") {
    return "That Slack workspace is not connected to this organization.";
  }
  if (code === "provider_not_configured") {
    return "Slack isn't set up on this Hub. Save the app credentials, then try again.";
  }
  if (status === 403) return "You don't have permission to reauthorize Slack.";
  if (code === "connection_unavailable" || status === 503) {
    return "Hub couldn't reach Slack to refresh this workspace. Try again.";
  }
  return "Hub couldn't reauthorize Slack. Try again.";
}

function connectionContext(
  operation: string,
  data: {
    organizationSlug: string;
    projectSlug?: string | undefined;
    provider?: ConnectionProvider | undefined;
  },
) {
  return {
    operation,
    component: "connections",
    organizationSlug: data.organizationSlug,
    ...(data.projectSlug === undefined ? {} : { projectSlug: data.projectSlug }),
    ...(data.provider === undefined ? {} : { provider: data.provider }),
  } as const;
}

function connectionResponseFailure(
  operation: string,
  response: Response,
  message: string,
  data: {
    organizationSlug: string;
    projectSlug?: string | undefined;
    provider?: ConnectionProvider | undefined;
  },
) {
  return respondWithFailure(
    new Error(`connection operation returned HTTP ${response.status}`),
    { ...connectionContext(operation, data), status: response.status },
    {
      fallback: message,
      authentication: message,
      forbidden: message,
      notFound: message,
      conflict: message,
      validation: message,
    },
    { status: response.status },
  );
}

function operationRequest(
  method: "GET" | "POST",
  path: string,
  scope: { organizationSlug: string; projectSlug?: string | undefined },
  connectionId?: string,
): Request {
  const incoming = getRequest();
  const headers = new Headers(incoming.headers);
  headers.delete("content-length");
  const url = new URL(path, incoming.url);
  url.searchParams.set("organizationSlug", scope.organizationSlug);
  if (scope.projectSlug !== undefined) url.searchParams.set("projectSlug", scope.projectSlug);
  if (connectionId !== undefined) url.searchParams.set("connectionId", connectionId);
  return new Request(url, {
    method,
    headers,
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}
