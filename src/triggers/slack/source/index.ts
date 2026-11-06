import type { SlackProviderApplicationConfiguration } from "../../../provider-applications/index.js";
import type { TriggerSource } from "../../index.js";
import {
  createSlackInteractivitySource,
  type SlackInteractionIntakeOptions,
} from "../interactivity.js";
import { createSlackWebhookSource } from "../webhook.js";
import type { SlackEventIntakeOptions } from "./internal/intake.js";
import {
  createSlackSocketSource,
  type SlackDeliveryStatus,
  type SlackSocketSourceOptions,
} from "./internal/socket.js";

export interface SlackEventSource extends TriggerSource {
  request?: (request: Request) => Promise<Response>;
  interactivity?: (request: Request) => Promise<Response>;
  status(): SlackDeliveryStatus;
  retry(): Promise<void>;
}

export interface CreateSlackEventSourceOptions {
  configuration: SlackProviderApplicationConfiguration;
  accept: SlackEventIntakeOptions["accept"];
  settlePlanDecision?: SlackInteractionIntakeOptions["settlePlanDecision"];
  socket?: Pick<
    SlackSocketSourceOptions,
    "apiUrl" | "random" | "timeoutMs" | "pingIntervalMs" | "pongTimeoutMs"
  >;
}

export function createSlackEventSource(options: CreateSlackEventSourceOptions): SlackEventSource {
  if (options.configuration.transport === "webhook") {
    const shared = {
      appId: options.configuration.appId,
      signingSecret: options.configuration.signingSecret,
      accept: (input: Parameters<SlackEventIntakeOptions["accept"]>[0]) => options.accept(input),
      ...(options.settlePlanDecision === undefined
        ? {}
        : { settlePlanDecision: options.settlePlanDecision }),
    };
    const webhook = createSlackWebhookSource(shared);
    const interactivity = createSlackInteractivitySource(shared);
    return {
      start: async (handler) => {
        await webhook.start(handler);
        await interactivity.start(handler);
      },
      stop: async () => {
        await webhook.stop();
        await interactivity.stop();
      },
      request: (request) => webhook.handle(request),
      interactivity: (request) => interactivity.handle(request),
      status: () => ({ state: "stopped" }),
      retry: () => Promise.resolve(),
    };
  }
  const socket = createSlackSocketSource({
    appId: options.configuration.appId,
    appToken: options.configuration.appToken,
    accept: (input) => options.accept(input),
    ...(options.settlePlanDecision === undefined
      ? {}
      : { settlePlanDecision: options.settlePlanDecision }),
    ...options.socket,
  });
  return socket;
}

export type { SlackDeliveryStatus } from "./internal/socket.js";
