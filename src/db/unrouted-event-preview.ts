import type { ProviderEventReceiptRecord, UnroutedProviderEvent } from "./types.js";

/** How much of a stored message the row keeps. The review opens the rest of the message. */
const SNIPPET_LENGTH = 180;

/**
 * One line of a readable message. Newlines become spaces so the row stays one line.
 *
 * @param value - The message, already trimmed
 * @returns The line the row shows, cut once it is longer than the row can use
 */
export function clipUnroutedText(value: string): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  if (flat.length <= SNIPPET_LENGTH) return flat;
  return `${flat.slice(0, SNIPPET_LENGTH).trimEnd()}...`;
}

/**
 * The readable slice of one receipt the overview already stored.
 *
 * Only strings that are actually on the payload are copied, and only the ones a person can
 * read: a channel, who sent it, the message, and a repository. A token, a file, or any other
 * key is left behind. The row keeps a short line. The message itself is kept whole so the
 * review can open it. A Slack workspace id is copied so the overview can ask Slack for names,
 * and the screen does not show that id. A missing string is left off the result.
 */
export function projectUnroutedProviderEvent(input: {
  id: string;
  provider: ProviderEventReceiptRecord["provider"];
  source: string;
  repo: string | null;
  receivedAt: Date;
  payload: unknown;
}): UnroutedProviderEvent {
  const channel = readChannel(input.payload);
  const author = readAuthor(input.payload);
  const message = readMessage(input.payload);
  const repository = shown(input.repo) ?? readRepository(input.payload);
  const teamId = readTeamId(input.payload);
  const text = message === undefined ? undefined : clipUnroutedText(message);
  return {
    id: input.id,
    provider: input.provider,
    source: input.source,
    receivedAt: input.receivedAt,
    ...(channel === undefined ? {} : { channel }),
    ...(author === undefined ? {} : { author }),
    ...(text === undefined ? {} : { text }),
    ...(message === undefined ? {} : { body: message }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(repository === undefined ? {} : { repository }),
  };
}

function readChannel(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  return readString(record, "channelId") ?? readString(record, "channel");
}

function readAuthor(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  return (
    readPerson(record["author"]) ??
    readPerson(record["actor"]) ??
    readPerson(record["sender"]) ??
    readPerson(record["user"]) ??
    readPerson(asRecord(record["comment"])?.["user"]) ??
    readNestedAuthor(record["payload"])
  );
}

/** GitHub stores the webhook one level down, under `payload`. Slack and the others do not. */
function readNestedAuthor(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  return (
    readPerson(record["sender"]) ??
    readPerson(asRecord(record["comment"])?.["user"]) ??
    readPerson(asRecord(record["issue"])?.["user"]) ??
    readPerson(asRecord(record["pull_request"])?.["user"]) ??
    readPerson(asRecord(record["review"])?.["user"])
  );
}

function readPerson(value: unknown): string | undefined {
  if (typeof value === "string") return shown(value);
  const record = asRecord(value);
  if (record === undefined) return undefined;
  return (
    readString(record, "username") ??
    readString(record, "name") ??
    readString(record, "login") ??
    readString(record, "id")
  );
}

function readTeamId(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  return readString(record, "teamId");
}

function readMessage(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  return readMessageFields(record) ?? readMessageFields(asRecord(record["payload"]));
}

function readMessageFields(record: Record<string, unknown> | undefined): string | undefined {
  if (record === undefined) return undefined;
  const direct =
    messageOf(record["content"]) ?? messageOf(record["text"]) ?? messageOf(record["lead"]);
  if (direct !== undefined) return direct;
  const comment = asRecord(record["comment"]);
  const review = asRecord(record["review"]);
  const issue = asRecord(record["issue"]);
  const pullRequest = asRecord(record["pull_request"]);
  return (
    messageOf(comment?.["body"]) ??
    messageOf(review?.["body"]) ??
    messageOf(issue?.["body"]) ??
    messageOf(issue?.["description"]) ??
    messageOf(pullRequest?.["body"]) ??
    messageOf(issue?.["title"]) ??
    messageOf(pullRequest?.["title"])
  );
}

function readRepository(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  const nested = asRecord(record["payload"]);
  return (
    readString(record, "repo") ??
    fullName(record["repository"]) ??
    (nested === undefined
      ? undefined
      : (readString(nested, "repo") ?? fullName(nested["repository"])))
  );
}

function fullName(value: unknown): string | undefined {
  const record = asRecord(value);
  return record === undefined ? undefined : readString(record, "full_name");
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? shown(value) : undefined;
}

function messageOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function shown(value: string | null): string | undefined {
  if (value === null) return undefined;
  const flat = value.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return undefined;
  if (flat.length <= SNIPPET_LENGTH) return flat;
  return `${flat.slice(0, SNIPPET_LENGTH).trimEnd()}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
