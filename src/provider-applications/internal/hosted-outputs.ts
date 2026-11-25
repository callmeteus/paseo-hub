import {
  replyOutputTool,
  type OutputToolDefinition,
} from "../../execution-capabilities/outputs.js";
import type { ProviderOutputRegistration } from "../../providers/registration.js";
import { reactOutputTool } from "../../triggers/slack/react.js";
import { telegramAgentTool } from "../../triggers/telegram/reply.js";
import type { Provider } from "../index.js";

interface HostedActive {
  registration: {
    outputs: readonly ProviderOutputRegistration[];
  };
}

interface HostedSlot<Active extends HostedActive> {
  active: Active | undefined;
}

/**
 * Outputs the hosted registration exposes to the agent.
 *
 * @param provider - Provider whose wrapper is being built
 * @param slot - Live registration slot
 * @param withLease - Runs the inner call while the registration stays active
 * @param unavailable - Error used when the inner output is gone
 * @returns Reply, plus Slack react when the provider is Slack
 */
export function hostedOutputs<Active extends HostedActive>(
  provider: Provider,
  slot: HostedSlot<Active>,
  withLease: (active: Active, operation: () => Promise<void>) => Promise<void>,
  unavailable: (code: string) => Error,
): ProviderOutputRegistration[] {
  // The agent only receives outputs declared here. The inner registration can
  // have more tools; a missing wrapper drops them before the model starts.
  // Telegram automations call `hub_telegram_reply`; the generic Slack reply
  // tool name would leave those agents without a working reply path.
  const replyTool =
    provider === "telegram" ? telegramAgentTool("telegram.reply") : replyOutputTool;
  const outputs = [
    hostedOutput(provider, slot, `${provider}.reply`, replyTool, withLease, unavailable),
  ];

  // Slack is the only provider whose agent picks the emoji itself
  if (provider === "slack") {
    outputs.push(
      hostedOutput(provider, slot, "slack.react", reactOutputTool, withLease, unavailable),
    );
  }

  // The Hub fires this internal output at run acceptance to show the typing
  // indicator while the agent works. It must be exposed by the hosted wrapper
  // too, otherwise the runtime has no executor for it.
  if (provider === "telegram") {
    outputs.push(
      hostedOutput(
        provider,
        slot,
        "telegram.typing",
        telegramAgentTool("telegram.typing"),
        withLease,
        unavailable,
      ),
    );
  }

  return outputs;
}

/**
 * One hosted output that delegates to the active inner registration.
 *
 * @param provider - Provider name used in the unavailable error
 * @param slot - Live registration slot
 * @param type - Output type, such as slack.react
 * @param tool - MCP tool definition the agent sees
 * @param withLease - Runs the inner call while the registration stays active
 * @param unavailable - Error used when the inner output is gone
 * @returns Output capability bound to the current registration
 */
function hostedOutput<Active extends HostedActive>(
  provider: Provider,
  slot: HostedSlot<Active>,
  type: string,
  tool: OutputToolDefinition,
  withLease: (active: Active, operation: () => Promise<void>) => Promise<void>,
  unavailable: (code: string) => Error,
): ProviderOutputRegistration {
  return {
    type,
    tool,
    available: (context) => {
      const output = slot.active?.registration.outputs.find((candidate) => candidate.type === type);
      return output !== undefined && (output.available?.(context) ?? true);
    },
    execute: async (input) => {
      const active = slot.active;
      const output = active?.registration.outputs.find((candidate) => candidate.type === type);

      // The registration was retired before this tool ran
      if (active === undefined || output === undefined) {
        throw unavailable(`${provider}_output_unavailable`);
      }

      // A read-only output answers with text the model reads; the lease only owns the call.
      let result: string | void = undefined;
      await withLease(active, async () => {
        result = await output.execute(input);
      });
      return result;
    },
  };
}
