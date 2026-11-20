import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type { NormalizedTelegramMessageEvent } from "./events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedTelegramTrigger {
  event: NormalizedTelegramMessageEvent;
  trigger: MatchedTriggerDefinition;
}

/**
 * Matches a normalized Telegram message against `telegram.message` / `telegram.mention` triggers.
 *
 * Group messages only run a `telegram.mention` trigger when the bot is mentioned; a plain
 * group message needs a `telegram.message` trigger. Private messages run `telegram.message`
 * triggers when `direct_messages` is on.
 */
export function matchTelegramTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedTelegramMessageEvent,
  botUsername: string,
  connectionId?: string | null,
): MatchedTelegramTrigger[] {
  const botId = botUsername;
  if (event.author.id === botId) return [];
  return config.triggers.flatMap((trigger) => {
    const expected = `telegram.${event.type}`;
    if (trigger.on !== expected) return [];
    if (!matchesFilter(event, trigger.filters, botId, connectionId)) return [];
    return [{ event, trigger }];
  });
}

function matchesFilter(
  event: NormalizedTelegramMessageEvent,
  filter: TriggerFilter | undefined,
  botId: string,
  connectionId?: string | null,
): boolean {
  if (filter === undefined) return false;

  if (event.author.isBot && filter.include_bots !== true) return false;

  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) return false;

  if (
    filter.from_users === undefined ||
    (!filter.from_users.includes("*") &&
      !filter.from_users.includes(event.author.id) &&
      (event.author.username === undefined || !filter.from_users.includes(event.author.username)))
  ) {
    return false;
  }

  // Group allowlist. Telegram chat ids are numeric strings.
  const groups = readStrings(filter, "groups");
  if (groups !== undefined && !groups.includes(event.chatId)) return false;
  const channels = readStrings(filter, "channels");
  if (channels !== undefined && !channels.includes(event.chatId)) return false;

  if (event.chatType === "private") {
    if (filter.direct_messages !== true) return false;
  } else if (event.type === "mention" && !event.mentionedBot) {
    return false;
  }

  return matchesText(event.content, filter);
}

function matchesText(text: string, filter: TriggerFilter): boolean {
  const clauses = [
    ...(filter.text ?? []).map((clause) => compileClause(clause)),
    ...(filter.regex ?? []).map((clause) => compileClause(clause)),
  ];
  return clauses.every((clause) => clause === undefined || clause.test(text));
}

function compileClause(clause: unknown): RegExp | undefined {
  if (typeof clause === "string") {
    try {
      return new RegExp(clause, "iu");
    } catch {
      return undefined;
    }
  }
  if (
    typeof clause === "object" &&
    clause !== null &&
    "regex" in clause &&
    typeof clause.regex === "string"
  ) {
    try {
      return new RegExp(clause.regex, "iu");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readStrings(filter: TriggerFilter, key: "groups" | "channels"): string[] | undefined {
  const value = Reflect.get(filter, key);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : undefined;
}

/** Removes the leading `@botusername` token so prompts do not include the mention. */
export function readTelegramPromptBody(
  event: NormalizedTelegramMessageEvent,
  botUsername: string,
): string {
  const token = `@${botUsername.replace(/^@/u, "")}`;
  const index = event.content.indexOf(token);
  return index < 0 ? event.content : event.content.slice(index + token.length).trimStart();
}
