import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type { NormalizedSlackMentionEvent } from "./events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

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
  const expectedOn = event.type === "message" ? "slack.message" : "slack.mention";
  return config.triggers.flatMap((trigger) => {
    return trigger.on === expectedOn &&
      acceptsBotMessage(event, trigger.filters) &&
      matchesFilters(event, trigger.filters, botUserId, connectionId)
      ? [{ event, trigger }]
      : [];
  });
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
  if (filters === undefined) return false;
  if (event.type === "mention" && !event.content.includes(`<@${botUserId}>`)) return false;
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
  const channels = readStrings(filters, "channels");
  if (channels !== undefined && !channels.includes(event.channelId)) return false;
  return matchesMessageBody(event, filters, botUserId);
}

/**
 * Term lists scan the raw message. A prefix marker, when present, still has to start the body.
 *
 * @param event - Normalized Slack event
 * @param filters - Trigger filters that already passed the audience checks
 * @param botUserId - Hub bot user id, used to strip the mention
 * @returns Whether the message text satisfies this trigger
 */
function matchesMessageBody(
  event: NormalizedSlackMentionEvent,
  filters: TriggerFilter,
  botUserId: string,
): boolean {
  if (!matchesTextTerms(event.content, filters)) return false;
  const pattern = readString(filters, "pattern") ?? readString(filters, "contains");
  if (pattern === undefined || pattern.length === 0) return true;
  const body = readSlackPromptBody(event, botUserId);
  if (!body.startsWith(pattern)) return false;
  const nextCharacter = body.at(pattern.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter);
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

// contains_all and contains_any scan the message body. contains and pattern stay a prefix.
function matchesTextTerms(text: string, filters: TriggerFilter): boolean {
  const required = readStrings(filters, "contains_all");
  if (required !== undefined && !required.every((term) => termAppears(text, term))) return false;
  const accepted = readStrings(filters, "contains_any");
  if (accepted !== undefined && !accepted.some((term) => termAppears(text, term))) return false;
  return true;
}

function termAppears(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
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

function readStrings(
  filters: TriggerFilter,
  key: "channels" | "contains_all" | "contains_any",
): string[] | undefined {
  const value = filters[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;
}
