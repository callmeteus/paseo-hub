import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type { NormalizedSlackMentionEvent } from "./events.js";
import { compileSlackTextClauses } from "./text-filter.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters"> & {
  steps?: CompiledTrigger["steps"];
};

export interface MatchedSlackTrigger {
  event: NormalizedSlackMentionEvent;
  trigger: MatchedTriggerDefinition;
}

export function matchSlackTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedSlackMentionEvent,
  botUserId: string,
  connectionId?: string | null,
): MatchedSlackTrigger[] {
  if (event.author.id === botUserId) return [];
  if (event.planDecision !== undefined) {
    // A click is stored as a channel message. One automation often listens for messages and
    // mentions in the same channel, and both copies ask for feedback. The message subscription
    // owns the click. A mention-only subscription still receives it when no message one matched.
    const matched = config.triggers.filter(
      (trigger) =>
        (trigger.on === "slack.message" || trigger.on === "slack.mention") &&
        triggerOffersFeedback(trigger) &&
        acceptsBotMessage(event, trigger.filters) &&
        matchesAudience(event, trigger.filters, connectionId),
    );
    const messageTriggers = matched.filter((trigger) => trigger.on === "slack.message");
    const chosen = messageTriggers.length > 0 ? messageTriggers : matched;
    return chosen.map((trigger) => ({ event, trigger }));
  }
  const expectedOn = event.type === "message" ? "slack.message" : "slack.mention";
  return config.triggers.flatMap((trigger) => {
    return trigger.on === expectedOn &&
      acceptsBotMessage(event, trigger.filters) &&
      matchesFilters(event, trigger.filters, botUserId, connectionId)
      ? [{ event, trigger }]
      : [];
  });
}

function triggerOffersFeedback(trigger: MatchedTriggerDefinition): boolean {
  return trigger.steps?.some((step) => step.slackAgent?.feedback === true) === true;
}

// Another app's message runs only the automations that opted in. The Hub's own user is already excluded.
function acceptsBotMessage(
  event: NormalizedSlackMentionEvent,
  filters: TriggerFilter | undefined,
): boolean {
  return event.fromBot !== true || filters?.include_bots === true;
}

function matchesFilters(
  event: NormalizedSlackMentionEvent,
  filters: TriggerFilter | undefined,
  botUserId: string,
  connectionId?: string | null,
): boolean {
  if (!matchesAudience(event, filters, connectionId)) return false;
  if (event.type === "mention" && !event.content.includes(`<@${botUserId}>`)) return false;
  if (filters === undefined) return false;
  return matchesMessageBody(event, filters);
}

/**
 * Audience checks shared by a channel message and a plan-card click.
 *
 * A click skips the text, regex, and mention-token checks. The person still has to be
 * allowed for this workspace, channel, and connection.
 *
 * @param event - Normalized Slack event
 * @param filters - Trigger filters
 * @param connectionId - Connection that delivered the event
 * @returns Whether this person and place are allowed
 */
function matchesAudience(
  event: NormalizedSlackMentionEvent,
  filters: TriggerFilter | undefined,
  connectionId?: string | null,
): boolean {
  if (filters === undefined) return false;
  if (
    filters.from_users === undefined ||
    (!filters.from_users.includes("*") &&
      !filters.from_users.includes(event.author.id) &&
      (event.author.username === undefined || !filters.from_users.includes(event.author.username)))
  )
    return false;
  if (filters.connectionId !== undefined && filters.connectionId !== connectionId) return false;
  const workspace = readString(filters, "workspace");
  if (workspace !== undefined && workspace !== event.teamId) return false;
  // A direct message is not a channel. The channel allowlist stays for posts, and this flag opts in.
  if (event.channelType === "im") return filters.direct_messages === true;
  const channels = readStrings(filters, "channels");
  if (channels !== undefined && !channels.includes(event.channelId)) return false;
  return true;
}

/**
 * Text filtering reads `regex` and `text` against the raw message. Every clause has to match.
 * A string in `text` is literal. `{ regex }` and every `regex` string are regular expressions.
 * The author writes anchors for a prefix. Legacy `contains`, `pattern`, `contains_all`,
 * and `contains_any` are not applied here; the compiler copies them into `regex` first.
 *
 * @param event - Normalized Slack event
 * @param filters - Trigger filters that already passed the audience checks
 * @returns Whether the message text satisfies this trigger
 */
function matchesMessageBody(event: NormalizedSlackMentionEvent, filters: TriggerFilter): boolean {
  return matchesTextTerms(event.content, filters);
}

export function readSlackPromptBody(event: NormalizedSlackMentionEvent, botUserId: string): string {
  const mention = `<@${botUserId}>`;
  const index = event.content.indexOf(mention);
  return index < 0 ? event.content : event.content.slice(index + mention.length).trimStart();
}

export function readSlackInvocationParserMessage(
  event: NormalizedSlackMentionEvent,
  botUserId: string,
  filters: TriggerFilter | undefined,
): string {
  const body = readSlackPromptBody(event, botUserId);
  const marker = filters === undefined ? undefined : readPatternMarker(filters);
  if (
    marker === undefined ||
    marker.length === 0 ||
    marker.includes("=") ||
    !body.startsWith(marker)
  )
    return body;
  const nextCharacter = body.at(marker.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter)
    ? body.slice(marker.length).trimStart()
    : body;
}

function matchesTextTerms(text: string, filters: TriggerFilter): boolean {
  const clauses = compileSlackTextClauses(filters);
  if (clauses === undefined) return true;
  return clauses.every((clause) => clause.test(text));
}

function readPatternMarker(filters: TriggerFilter): string | undefined {
  return readString(filters, "pattern") ?? readString(filters, "contains");
}

function readString(
  filters: TriggerFilter,
  key: "workspace" | "pattern" | "contains",
): string | undefined {
  const value = filters[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStrings(filters: TriggerFilter, key: "channels"): string[] | undefined {
  const value = filters[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;
}
