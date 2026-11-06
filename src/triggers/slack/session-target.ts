import type { AgentExecutionRecord } from "../../db/types.js";

export interface SlackSessionLocator {
  teamId: string;
  channelId: string;
  threadTs: string;
}

/**
 * Whether this execution is the Slack thread the person stopped.
 *
 * The reply target stores the channel and the thread the session lives on.
 * A channel post uses its own timestamp as that thread.
 *
 * @param execution - Run that may still be working
 * @param session - Channel and thread from `agent_session_stopped`
 * @returns True when the run's Slack target is that session
 */
export function slackExecutionTargetsSession(
  execution: Pick<AgentExecutionRecord, "outputContext" | "triggerContext">,
  session: SlackSessionLocator,
): boolean {
  return [execution.outputContext, readTarget(execution.triggerContext)].some((value) =>
    contextTargetsSession(value, session),
  );
}

function readTarget(triggerContext: unknown): unknown {
  if (!isRecord(triggerContext)) return undefined;
  return triggerContext["target"];
}

function contextTargetsSession(value: unknown, session: SlackSessionLocator): boolean {
  if (!isRecord(value) || value["provider"] !== "slack") return false;
  return (
    value["teamId"] === session.teamId &&
    value["channelId"] === session.channelId &&
    value["threadTs"] === session.threadTs
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
