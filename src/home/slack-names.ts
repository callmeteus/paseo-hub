import type { UnroutedProviderEvent } from "../db/types.js";
import { clipUnroutedText } from "../db/unrouted-event-preview.js";
import { reportFailure } from "../failures/index.js";
import type { SlackNameDirectory } from "../triggers/slack/client.js";

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/u;
const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]+$/u;
const USER_MENTION = String.raw`<@([UW][A-Z0-9]+)(?:\|[^>]*)?>`;
const SUBTEAM_MENTION = String.raw`<!subteam\^([S][A-Z0-9]+)(?:\|[^>]*)?>`;
const CHANNEL_MENTION = String.raw`<#([CG][A-Z0-9]+)(?:\|[^>]*)?>`;

/** Shortcodes the review draws as the character. Anything else stays as Slack stored it. */
const KNOWN_EMOJI = new Map<string, string>([
  ["warning", "⚠️"],
  ["white_check_mark", "✅"],
]);

interface NameCache {
  /** False when this Hub has no Slack client to ask. */
  enabled: boolean;
  user(teamId: string, userId: string): Promise<string | undefined>;
  channel(teamId: string, channelId: string): Promise<string | undefined>;
  group(teamId: string, groupId: string): Promise<string | undefined>;
}

/**
 * Fills Slack ids on the overview's events with the names the workspace returns.
 *
 * A lookup that fails leaves that stored id in place, and the other events stay in the list.
 * Known emoji shortcodes become the character either way, because that does not ask Slack.
 * The workspace id is dropped here: the screen does not show it.
 *
 * @param events - The review rows, newest first, still carrying the workspace id
 * @param names - The connected Slack client, or none when this Hub has no Slack app
 * @param organizationId - The organization whose bot token the client already holds
 * @returns The same events, with readable text
 */
export async function resolveUnroutedEventNames(
  events: readonly UnroutedProviderEvent[],
  names: SlackNameDirectory | undefined,
  organizationId: string,
): Promise<UnroutedProviderEvent[]> {
  const cache = createNameCache(names, organizationId);
  return Promise.all(events.map((event) => resolveOne(event, cache)));
}

async function resolveOne(
  event: UnroutedProviderEvent,
  cache: NameCache,
): Promise<UnroutedProviderEvent> {
  try {
    const named = await resolveNames(event, cache);
    return withReadableText(named, emojiOf(named));
  } catch (error) {
    reportFailure(error, {
      operation: "home.unrouted.resolve",
      component: "home",
      ...(event.provider === "slack" ||
      event.provider === "github" ||
      event.provider === "discord" ||
      event.provider === "linear"
        ? { provider: event.provider }
        : {}),
    });
    return withReadableText(event, emojiOf(event));
  }
}

async function resolveNames(
  event: UnroutedProviderEvent,
  cache: NameCache,
): Promise<UnroutedProviderEvent> {
  if (!cache.enabled || event.provider !== "slack" || event.teamId === undefined) return event;
  const teamId = event.teamId;
  const message = event.body ?? event.text;
  const body = message === undefined ? undefined : await resolveSlackText(message, teamId, cache);
  const channel =
    event.channel === undefined ? undefined : await resolveChannel(event.channel, teamId, cache);
  const author =
    event.author === undefined ? undefined : await resolveAuthor(event.author, teamId, cache);
  return {
    ...event,
    ...(channel === undefined ? {} : { channel }),
    ...(author === undefined ? {} : { author }),
    ...(body === undefined ? {} : { body }),
  };
}

async function resolveSlackText(text: string, teamId: string, cache: NameCache): Promise<string> {
  const withUsers = await replaceMentions(text, USER_MENTION, (id) => cache.user(teamId, id), at);
  const withGroups = await replaceMentions(
    withUsers,
    SUBTEAM_MENTION,
    (id) => cache.group(teamId, id),
    at,
  );
  return replaceMentions(withGroups, CHANNEL_MENTION, (id) => cache.channel(teamId, id), hash);
}

async function resolveChannel(channel: string, teamId: string, cache: NameCache): Promise<string> {
  if (!SLACK_CHANNEL_ID.test(channel)) return channel;
  const name = await cache.channel(teamId, channel);
  return name ?? channel;
}

async function resolveAuthor(author: string, teamId: string, cache: NameCache): Promise<string> {
  if (!SLACK_USER_ID.test(author)) return author;
  const name = await cache.user(teamId, author);
  return name ?? author;
}

async function replaceMentions(
  text: string,
  source: string,
  lookup: (id: string) => Promise<string | undefined>,
  format: (name: string) => string,
): Promise<string> {
  const matches = [...text.matchAll(new RegExp(source, "gu"))];
  if (matches.length === 0) return text;
  const names = await Promise.all(
    matches.map((match) => {
      const id = match[1];
      return id === undefined ? Promise.resolve(undefined) : lookup(id);
    }),
  );
  let cursor = 0;
  let result = "";
  for (const [index, match] of matches.entries()) {
    if (match.index === undefined) continue;
    const name = names[index];
    result += text.slice(cursor, match.index);
    result += name === undefined ? match[0] : format(name);
    cursor = match.index + match[0].length;
  }
  return result + text.slice(cursor);
}

function emojiOf(event: UnroutedProviderEvent): string | undefined {
  const message = event.body ?? event.text;
  return message === undefined ? undefined : replaceKnownEmoji(message);
}

function replaceKnownEmoji(text: string): string {
  return text.replace(
    /:([a-z0-9_+-]+):/gu,
    (token, name: string) => KNOWN_EMOJI.get(name) ?? token,
  );
}

function at(name: string): string {
  return `@${name}`;
}

function hash(name: string): string {
  return `#${name}`;
}

function withReadableText(
  event: UnroutedProviderEvent,
  message: string | undefined,
): UnroutedProviderEvent {
  const clipped = message === undefined ? undefined : clipUnroutedText(message);
  const text = clipped === undefined || clipped.length === 0 ? undefined : clipped;
  return {
    id: event.id,
    provider: event.provider,
    source: event.source,
    receivedAt: event.receivedAt,
    ...(event.channel === undefined ? {} : { channel: event.channel }),
    ...(event.author === undefined ? {} : { author: event.author }),
    ...(text === undefined ? {} : { text }),
    ...(message === undefined ? {} : { body: message }),
    ...(event.repository === undefined ? {} : { repository: event.repository }),
  };
}

function createNameCache(names: SlackNameDirectory | undefined, organizationId: string): NameCache {
  if (names === undefined) {
    return {
      enabled: false,
      user: () => Promise.resolve(undefined),
      channel: () => Promise.resolve(undefined),
      group: () => Promise.resolve(undefined),
    };
  }
  const users = new Map<string, Promise<string | undefined>>();
  const channels = new Map<string, Promise<string | undefined>>();
  const groups = new Map<string, Promise<ReadonlyMap<string, string>>>();
  return {
    enabled: true,
    user(teamId, userId) {
      return remember(users, `${teamId}:${userId}`, () =>
        loadName(names.lookupUserName({ organizationId, teamId, userId }), "slack.user.lookup", {
          teamId,
          userId,
        }),
      );
    },
    channel(teamId, channelId) {
      return remember(channels, `${teamId}:${channelId}`, () =>
        loadName(
          names.lookupChannelName({ organizationId, teamId, channelId }),
          "slack.channel.lookup",
          { teamId, channelId },
        ),
      );
    },
    group(teamId, groupId) {
      const list = remember(groups, teamId, () => loadGroups(names, organizationId, teamId));
      return list.then((found) => found.get(groupId));
    },
  };
}

function remember<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const pending = load();
  cache.set(key, pending);
  return pending;
}

async function loadName(
  pending: Promise<string | undefined>,
  operation: string,
  diagnostic: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    return usableName(await pending);
  } catch (error) {
    reportFailure(error, { operation, component: "home", provider: "slack" }, { diagnostic });
    return undefined;
  }
}

async function loadGroups(
  names: SlackNameDirectory,
  organizationId: string,
  teamId: string,
): Promise<ReadonlyMap<string, string>> {
  try {
    const listed = await names.listUserGroupNames({ organizationId, teamId });
    const clean = new Map<string, string>();
    for (const [id, name] of listed) {
      const usable = usableName(name);
      if (usable !== undefined) clean.set(id, usable);
    }
    return clean;
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.usergroup.lookup", component: "home", provider: "slack" },
      { diagnostic: { teamId } },
    );
    return new Map();
  }
}

function usableName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = value.replace(/\s+/gu, " ").trim();
  return name.length === 0 ? undefined : name;
}
