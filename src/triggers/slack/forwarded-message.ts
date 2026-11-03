/** How many forwarded layers to read before stopping. A cycle must not recurse forever. */
export const MAX_SLACK_FORWARD_DEPTH = 32;

const SLACK_TS = /^\d+\.\d+$/u;

export interface SlackForwardLocator {
  channelId: string;
  messageTs: string;
}

export interface SlackForwardFile {
  id: string;
  name: string | undefined;
  title: string | undefined;
  mimetype: string | undefined;
  size: number | undefined;
}

/**
 * Reads the text a person sees, including every forwarded message inside it.
 *
 * Slack stores a forward on `attachments`, not on `text`. Each layer can
 * contain another forward.
 *
 * @param message - Slack message object from an event or from history
 * @returns The message text, then each forwarded layer
 */
export function readSlackMessageText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }

  const own = readString(message, "text") ?? readBlocks(message["blocks"]);
  const forwarded = readForwardList(message["attachments"], 0, new WeakSet());

  if (own.length === 0) {
    return forwarded;
  }

  if (forwarded.length === 0) {
    return own;
  }

  return `${own}\n\n${forwarded}`;
}

/**
 * Collects file metadata from the message and from forwarded layers.
 *
 * @param message - Slack message object from an event or from history
 * @returns Files in encounter order, without duplicate ids
 */
export function readSlackMessageFiles(message: unknown): SlackForwardFile[] {
  const files: SlackForwardFile[] = [];
  collectFiles(message, files, new Set(), new WeakSet(), 0);
  return files;
}

/**
 * Text the sender typed on this message, without forwarded layers.
 *
 * @param message - Slack message object
 * @returns The sender's own text
 */
export function readSlackMessageLead(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }

  return readString(message, "text") ?? readBlocks(message["blocks"]);
}

/**
 * Channel and timestamp of each forward attached directly to this message.
 *
 * Nested forwards stay on the source message. The reader follows them one hop
 * at a time, and a private channel the bot cannot open is skipped.
 *
 * @param message - Slack message object
 * @returns Locators of the immediate forwarded messages
 */
export function readSlackForwardLocators(message: unknown): SlackForwardLocator[] {
  if (!isRecord(message) || !Array.isArray(message["attachments"])) {
    return [];
  }

  const locators: SlackForwardLocator[] = [];

  for (const attachment of message["attachments"]) {
    if (!isRecord(attachment)) {
      continue;
    }

    const locator = shareLocator(attachment);

    if (locator !== undefined) {
      locators.push(locator);
    }
  }

  return locators;
}

/**
 * Follows forwards into channels the bot can read, and keeps the unfurl when it cannot.
 *
 * A private conversation stays closed. Its text and files are whatever Slack
 * already copied onto a message in a channel the bot belongs to.
 *
 * @param event - Normalized message, including the sync unfurl as a fallback
 * @param readMessage - Loads one Slack message. Undefined means that channel is closed
 * @returns The text and files the agent should see
 */
export async function expandStoredSlackForwards(
  event: {
    lead: string;
    content: string;
    forwards: readonly SlackForwardLocator[];
    attachments: readonly {
      id: string;
      filename: string;
      contentType: string | null;
      size: number | null;
    }[];
  },
  readMessage: (locator: SlackForwardLocator) => Promise<unknown>,
): Promise<{ content: string; files: SlackForwardFile[] }> {
  const current = event.attachments.map((file) => ({
    id: file.id,
    name: file.filename,
    title: undefined,
    mimetype: file.contentType ?? undefined,
    size: file.size ?? undefined,
  }));

  if (event.forwards.length === 0) {
    return { content: event.content, files: current };
  }

  const seen = new Set<string>();
  const parts: string[] = [];
  const files: SlackForwardFile[] = [];
  let replaced = false;

  for (const locator of event.forwards) {
    const source = await readUnseen(locator, readMessage, seen);

    if (source === undefined) {
      continue;
    }

    const expanded = await expandRaw(source, readMessage, seen, 1);

    if (expanded.text.length === 0 && expanded.files.length === 0) {
      continue;
    }

    replaced = true;

    if (expanded.text.length > 0) {
      parts.push(expanded.text);
    }

    files.push(...expanded.files);
  }

  if (!replaced) {
    return { content: event.content, files: current };
  }

  const lead = event.lead.trim();
  const content = [lead, ...parts].filter((part) => part.length > 0).join("\n\n");

  return {
    content: content.length > 0 ? content : event.content,
    files: dedupeFiles([...current, ...files]),
  };
}

/**
 * Reads one list of Slack attachments, skipping link previews at the top.
 *
 * @param attachments - `attachments` array from a message or a forward
 * @param depth - How many forwards are already open
 * @param seen - Attachments already rendered, so a cycle stops
 * @returns Rendered forwards, separated by a blank line
 */
function readForwardList(attachments: unknown, depth: number, seen: WeakSet<object>): string {
  if (!Array.isArray(attachments) || depth > MAX_SLACK_FORWARD_DEPTH) {
    return "";
  }

  const parts: string[] = [];

  for (const attachment of attachments) {
    if (!isRecord(attachment) || seen.has(attachment)) {
      continue;
    }

    // A link preview sits beside the message. Only a forward is part of the text.
    if (depth === 0 && !isForward(attachment)) {
      continue;
    }

    seen.add(attachment);
    const rendered = renderForward(attachment, depth, seen);

    if (rendered.length > 0) {
      parts.push(rendered);
    }
  }

  return parts.join("\n\n");
}

/**
 * Renders one forwarded message and the forwards inside it.
 *
 * @param attachment - One Slack attachment
 * @param depth - How many forwards are already open
 * @param seen - Attachments already rendered
 * @returns The layer, or an empty string when it has nothing to read
 */
function renderForward(
  attachment: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): string {
  const body = forwardBody(attachment);
  const nested = readForwardList(attachment["attachments"], depth + 1, seen);
  const author = readString(attachment, "author_name") ?? readString(attachment, "author_subname");
  const header = author === undefined ? "Encaminhada:" : `Encaminhada de ${author}:`;

  if (body.length === 0 && nested.length === 0) {
    return "";
  }

  const lines = [header];

  if (body.length > 0) {
    lines.push(body);
  }

  if (nested.length > 0) {
    lines.push(nested);
  }

  return lines.join("\n");
}

/**
 * Prefers the plain text Slack already extracted, then Block Kit, then fallback.
 *
 * @param attachment - One Slack attachment
 * @returns The body of this layer
 */
function forwardBody(attachment: Record<string, unknown>): string {
  const text = readString(attachment, "text");

  if (text !== undefined) {
    return text;
  }

  const blocks = readBlocks(attachment["blocks"]);

  if (blocks.length > 0) {
    return blocks;
  }

  return readString(attachment, "fallback") ?? "";
}

/**
 * True when this attachment is a forwarded or unfurled Slack message.
 *
 * @param attachment - One Slack attachment
 * @returns Whether the attachment carries another message
 */
/**
 * Reads one message and the forwards inside it.
 *
 * @param message - Slack message returned by `conversations.history`
 * @param readMessage - Loads a forwarded source. Undefined means it is closed
 * @param seen - Channel and timestamp pairs already opened
 * @param depth - How many forwards are already open
 * @returns Text and files for this message
 */
async function expandRaw(
  message: unknown,
  readMessage: (locator: SlackForwardLocator) => Promise<unknown>,
  seen: Set<string>,
  depth: number,
): Promise<{ text: string; files: SlackForwardFile[] }> {
  if (!isRecord(message) || depth > MAX_SLACK_FORWARD_DEPTH) {
    return { text: "", files: [] };
  }

  const parts: string[] = [];
  const own = readString(message, "text") ?? readBlocks(message["blocks"]);

  if (own.length > 0) {
    parts.push(own);
  }

  const files = directFiles(message);
  const attachments = message["attachments"];

  if (!Array.isArray(attachments)) {
    return { text: parts.join("\n\n"), files };
  }

  for (const attachment of attachments) {
    if (!isRecord(attachment) || !isForward(attachment)) {
      continue;
    }

    const locator = shareLocator(attachment);
    let usedSource = false;

    if (locator !== undefined) {
      const source = await readUnseen(locator, readMessage, seen);

      if (source !== undefined) {
        const nested = await expandRaw(source, readMessage, seen, depth + 1);
        usedSource = nested.text.length > 0 || nested.files.length > 0;

        if (nested.text.length > 0) {
          parts.push(nested.text);
        }

        files.push(...nested.files);
      }
    }

    // The source channel is private or gone. Keep the copy Slack attached here.
    if (!usedSource) {
      const fallback = renderForward(attachment, 0, new WeakSet());

      if (fallback.length > 0) {
        parts.push(fallback);
      }

      files.push(...filesInside(attachment));
    }
  }

  return { text: parts.join("\n\n"), files: dedupeFiles(files) };
}

/**
 * Opens a forward once. A repeated locator is a cycle.
 *
 * @param locator - Channel and timestamp of the source message
 * @param readMessage - Loads that message
 * @param seen - Locators already requested
 * @returns The source message, or undefined when it cannot be read
 */
async function readUnseen(
  locator: SlackForwardLocator,
  readMessage: (locator: SlackForwardLocator) => Promise<unknown>,
  seen: Set<string>,
): Promise<unknown> {
  const key = `${locator.channelId}:${locator.messageTs}`;

  if (seen.has(key)) {
    return undefined;
  }

  seen.add(key);

  try {
    return await readMessage(locator);
  } catch {
    return undefined;
  }
}

/**
 * Reads the channel and timestamp Slack puts on a forwarded message.
 *
 * @param attachment - One Slack attachment
 * @returns The source locator, or undefined when this is not a forward
 */
function shareLocator(attachment: Record<string, unknown>): SlackForwardLocator | undefined {
  if (!isForward(attachment)) {
    return undefined;
  }

  const channelId = attachment["channel_id"];
  const messageTs = attachment["ts"];

  if (typeof channelId !== "string" || channelId.length === 0 || channelId.length > 255) {
    return undefined;
  }

  if (typeof messageTs !== "string" || !SLACK_TS.test(messageTs)) {
    return undefined;
  }

  return { channelId, messageTs };
}

/**
 * Files uploaded on this message, not files that belong to a forward.
 *
 * @param message - Slack message object
 * @returns Those files
 */
function directFiles(message: Record<string, unknown>): SlackForwardFile[] {
  const listed = message["files"];

  if (!Array.isArray(listed)) {
    return [];
  }

  const files: SlackForwardFile[] = [];
  const ids = new Set<string>();

  for (const file of listed) {
    const parsed = readFile(file);

    if (parsed === undefined || ids.has(parsed.id)) {
      continue;
    }

    ids.add(parsed.id);
    files.push(parsed);
  }

  return files;
}

/**
 * Files copied onto a forward, including files on the layers inside it.
 *
 * @param attachment - One forwarded attachment
 * @returns Those files
 */
function filesInside(attachment: unknown): SlackForwardFile[] {
  const files: SlackForwardFile[] = [];
  collectFiles(attachment, files, new Set(), new WeakSet(), 1);
  return files;
}

/**
 * Keeps the first copy of each file id.
 *
 * @param files - Files found while walking forwards
 * @returns Files without duplicate ids
 */
function dedupeFiles(files: readonly SlackForwardFile[]): SlackForwardFile[] {
  const ids = new Set<string>();
  const unique: SlackForwardFile[] = [];

  for (const file of files) {
    if (ids.has(file.id)) {
      continue;
    }

    ids.add(file.id);
    unique.push(file);
  }

  return unique;
}

/**
 * True when this attachment is a forwarded or unfurled Slack message.
 *
 * @param attachment - One Slack attachment
 * @returns Whether the attachment carries another message
 */
function isForward(attachment: Record<string, unknown>): boolean {
  return (
    attachment["is_share"] === true ||
    attachment["is_msg_unfurl"] === true ||
    attachment["is_thread_root_unfurl"] === true
  );
}

/**
 * Walks Block Kit rich text when the attachment has no plain `text`.
 *
 * @param blocks - Slack `blocks` array
 * @returns The visible text
 */
function readBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) {
    return "";
  }

  const parts: string[] = [];

  for (const block of blocks) {
    const piece = readRichText(block);

    if (piece.length > 0) {
      parts.push(piece);
    }
  }

  return parts.join("\n");
}

/**
 * Reads one rich-text node, including the nodes nested inside it.
 *
 * @param node - A Block Kit element
 * @returns The visible text of that node
 */
function readRichText(node: unknown): string {
  if (!isRecord(node)) {
    return "";
  }

  const type = node["type"];

  if (type === "text" || type === "link") {
    const text = readString(node, "text");

    if (text !== undefined) {
      return text;
    }

    if (type === "link") {
      return readString(node, "url") ?? "";
    }

    return "";
  }

  if (type === "emoji") {
    const name = readString(node, "name");
    return name === undefined ? "" : `:${name}:`;
  }

  if (type === "user") {
    const id = readString(node, "user_id");
    return id === undefined ? "" : `<@${id}>`;
  }

  if (type === "channel") {
    const id = readString(node, "channel_id");
    return id === undefined ? "" : `<#${id}>`;
  }

  const elements = node["elements"];

  if (!Array.isArray(elements)) {
    return "";
  }

  const separator = type === "rich_text_section" ? "" : "\n";
  const parts: string[] = [];

  for (const element of elements) {
    const piece = readRichText(element);

    if (piece.length > 0) {
      parts.push(piece);
    }
  }

  return parts.join(separator);
}

/**
 * Adds files from this object, then from forwarded layers.
 *
 * @param node - Message or attachment
 * @param files - Files found so far
 * @param ids - File ids already recorded
 * @param seen - Objects already walked
 * @param depth - How many forwards are already open
 * @returns Nothing.
 */
function collectFiles(
  node: unknown,
  files: SlackForwardFile[],
  ids: Set<string>,
  seen: WeakSet<object>,
  depth: number,
): void {
  if (!isRecord(node) || seen.has(node) || depth > MAX_SLACK_FORWARD_DEPTH) {
    return;
  }

  seen.add(node);
  const listed = node["files"];

  if (Array.isArray(listed)) {
    for (const file of listed) {
      const parsed = readFile(file);

      if (parsed === undefined || ids.has(parsed.id)) {
        continue;
      }

      ids.add(parsed.id);
      files.push(parsed);
    }
  }

  const attachments = node["attachments"];

  if (!Array.isArray(attachments)) {
    return;
  }

  for (const attachment of attachments) {
    if (!isRecord(attachment)) {
      continue;
    }

    if (depth === 0 && !isForward(attachment)) {
      continue;
    }

    collectFiles(attachment, files, ids, seen, depth + 1);
  }
}

/**
 * Reads one Slack file object.
 *
 * @param value - One item of a `files` array
 * @returns The file metadata, or undefined when the id is missing
 */
function readFile(value: unknown): SlackForwardFile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = value["id"];

  if (typeof id !== "string" || id.length === 0 || id.length > 255) {
    return undefined;
  }

  const size = value["size"];

  return {
    id,
    name: optionalString(value, "name"),
    title: optionalString(value, "title"),
    mimetype: optionalString(value, "mimetype"),
    size: typeof size === "number" && Number.isInteger(size) && size >= 0 ? size : undefined,
  };
}

/**
 * Reads a trimmed string field.
 *
 * @param record - Slack object
 * @param key - Field name
 * @returns The trimmed text, or undefined when it is missing or blank
 */
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed;
}

/**
 * Reads an optional short string field.
 *
 * @param record - Slack object
 * @param key - Field name
 * @returns The string, or undefined when it is missing or too long
 */
function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = readString(record, key);

  if (value === undefined || value.length > 255) {
    return undefined;
  }

  return value;
}

/**
 * True for a JSON object. Arrays are walked by the caller.
 *
 * @param value - Unknown Slack payload
 * @returns Whether the value is a non-null object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
