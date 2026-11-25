import {
  replyOutputTool,
  type OutputToolDefinition,
} from "../../execution-capabilities/outputs.js";
import type { ProviderOutputRegistration } from "../../providers/registration.js";
import { reactOutputTool } from "../../triggers/slack/react.js";
import { readSlackMessagesTool } from "../../triggers/slack/read-messages.js";
import { slackAgentTool } from "../../triggers/slack/agent-surface.js";
import { SLACK_AGENT_OUTPUT_TYPES } from "../../triggers/slack/agent-block.js";
import { telegramAgentTool } from "../../triggers/telegram/reply.js";
import type { Provider } from "../index.js";
import { OUTPUT_TYPES as TELEGRAM_OUTPUT_TYPES } from "../../providers/telegram/index.js";
import { SLACK_OUTPUT_TYPES } from "../../providers/slack/index.js";

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
  // The agent only receives outputs declared here. Derive the list from each
  // provider's own declarations so a new output cannot be silently dropped
  // (that is how telegram.typing, telegram.agent.finish and slack.read_messages
  // were all lost before).
  return declaredOutputs(provider).map(({ type, tool }) =>
    hostedOutput(provider, slot, type, tool, withLease, unavailable),
  );
}

/** The outputs a provider declares, paired with the tool the model calls. */
function declaredOutputs(
  provider: Provider,
): readonly { type: string; tool: OutputToolDefinition }[] {
  if (provider === "telegram") {
    return TELEGRAM_OUTPUT_TYPES.map((type) => ({ type, tool: telegramAgentTool(type) }));
  }
  if (provider === "slack") {
    return SLACK_OUTPUT_TYPES.map((type) => ({ type, tool: slackOutputTool(type) }));
  }
  return [{ type: `${provider}.reply`, tool: replyOutputTool }];
}

function slackOutputTool(type: string): OutputToolDefinition {
  if (type === "slack.reply") return replyOutputTool;
  if (type === "slack.react") return reactOutputTool;
  if (type === "slack.read_messages") return readSlackMessagesTool;
  const agentType = SLACK_AGENT_OUTPUT_TYPES.find((candidate) => candidate === type);
  if (agentType !== undefined) return slackAgentTool(agentType);
  return replyOutputTool;
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
