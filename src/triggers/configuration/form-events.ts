import type { Document } from "yaml";
import { DEFAULT_RECURRENCE } from "../schedule/recurrence.js";
import {
  parseSlackMessageField,
  slackFiltersFromField,
  slackMessageFieldText,
} from "../slack/text-filter.js";
import type { TriggerDocument } from "./schema.js";
import {
  eventDefinition,
  isEditorEvent,
  type EditorEvent,
  type QualifierKey,
  type QualifierValues,
} from "./events.js";
import type { TriggerFormValue } from "./editor.js";

/**
 * Events the form can show together. They share one connection.
 * Each event may listen to different channels, different people, and different message text.
 * A filter the form does not own stays on the document. Two events that disagree on the
 * connection stay in YAML.
 *
 * @param trigger - Parsed trigger document
 * @returns The shared event fields, or why the form cannot open
 */
export function projectEditorEvents(
  trigger: TriggerDocument,
): ({ status: "editable" } & ProjectedEvents) | { status: "yaml_only"; reason: string } {
  const entries = Object.entries(trigger.on);
  if (entries.length === 0) {
    return { status: "yaml_only", reason: "The form supports at least one event." };
  }
  const events: EditorEvent[] = [];
  for (const [event] of entries) {
    if (!isEditorEvent(event)) {
      return { status: "yaml_only", reason: `The form does not support the ${event} event.` };
    }
    events.push(event);
  }
  const [first] = events;
  if (first === undefined) {
    return { status: "yaml_only", reason: "The form supports at least one event." };
  }
  const provider = eventDefinition(first).provider;
  if (events.some((event) => eventDefinition(event).provider !== provider)) {
    return { status: "yaml_only", reason: "The form edits events that share one connection." };
  }
  if (eventDefinition(first).origin === "hub" && events.length > 1) {
    return { status: "yaml_only", reason: "The form supports that event on its own." };
  }
  const definitions = entries.map(([, definition]) => definition);
  const [firstDefinition] = definitions;
  if (firstDefinition === undefined) {
    return { status: "yaml_only", reason: "The form supports at least one event." };
  }
  if (
    definitions.some(
      (definition) => (definition.connection ?? "") !== (firstDefinition.connection ?? ""),
    )
  ) {
    return { status: "yaml_only", reason: "These events use different connections." };
  }
  const botValues = definitions.flatMap((definition) =>
    definition.filters?.include_bots === undefined ? [] : [definition.filters.include_bots],
  );
  if (new Set(botValues).size > 1) {
    return { status: "yaml_only", reason: "Bot messages are set differently on each event." };
  }
  const qualifiers = JSON.stringify(readQualifiers(first, firstDefinition.filters));
  for (const [event, definition] of entries) {
    if (!isEditorEvent(event)) continue;
    if (JSON.stringify(readQualifiers(event, definition.filters)) !== qualifiers) {
      return { status: "yaml_only", reason: "These events use different filters." };
    }
    if (
      eventDefinition(event).provider === "slack" &&
      slackMessageFieldText({
        text: definition.filters?.text,
        regex: definition.filters?.regex,
      }) === undefined
    ) {
      return {
        status: "yaml_only",
        reason: "A message pattern cannot be edited in the form.",
      };
    }
  }
  const message = entries.find(([event]) => event === "slack.message");
  return {
    status: "editable",
    events,
    includeBots: botValues.some((value) => value),
    directMessages: message?.[1].filters?.direct_messages === true,
    ...readProjectedEventFields(entries),
  };
}

/**
 * People and message text copied off each event the form can edit.
 *
 * @param entries - Event name and definition pairs from the document
 * @returns The per-event fields
 */
function readProjectedEventFields(
  entries: [string, TriggerDocument["on"][string]][],
): Pick<ProjectedEvents, "eventUsers" | "regex" | "eventChannels"> {
  const eventUsers: Partial<Record<EditorEvent, string>> = {};
  const regex: Partial<Record<EditorEvent, string>> = {};
  const eventChannels: Partial<Record<EditorEvent, string>> = {};
  for (const [event, definition] of entries) {
    if (!isEditorEvent(event)) continue;
    eventUsers[event] = definition.filters?.from_users?.join(", ") ?? "*";
    regex[event] =
      slackMessageFieldText({
        text: definition.filters?.text,
        regex: definition.filters?.regex,
      }) ?? "";
    eventChannels[event] = definition.filters?.channels?.join(", ") ?? "";
  }
  return { eventUsers, regex, eventChannels };
}

/** People and message text the form keeps per event. */
export interface ProjectedEvents {
  events: EditorEvent[];
  includeBots: boolean;
  /** `slack.message` also runs for a one-to-one direct message. */
  directMessages: boolean;
  eventUsers: Partial<Record<EditorEvent, string>>;
  /** Channel ids for one event, comma-separated. Empty listens to every channel. */
  eventChannels: Partial<Record<EditorEvent, string>>;
  /**
   * One message item per line. A line that starts with `regex:` is an expression.
   * Any other line is literal text. Empty when that event does not filter on text.
   */
  regex: Partial<Record<EditorEvent, string>>;
}

/**
 * Cursor Fast as the form stores it. Missing means Off, because a new run sends that unless the
 * workflow asks for Fast.
 *
 * @param agent - Compiled agent that is not an agent choice
 * @returns `"true"`, `"false"`, or empty when the provider is not Cursor
 */
export function cursorFastValue(
  agent: Extract<
    Extract<TriggerDocument["run"], { agent: unknown }>["agent"],
    { provider: string }
  >,
): string {
  if (agent.provider !== "cursor") return "";
  return agent.features?.["fast"] === "true" ? "true" : "false";
}

/**
 * One event block the form writes when it creates a document from scratch.
 *
 * @param value - Current form
 * @param event - Event this block belongs to
 * @returns The `on` entry for that event
 */
export function formEventDefinition(
  value: TriggerFormValue,
  event: EditorEvent,
): TriggerDocument["on"][string] {
  if (event === "schedule.tick") return { recurrence: value.recurrence ?? DEFAULT_RECURRENCE };
  if (event === "webhook.received") {
    return { filters: { webhook_secret: value.webhookSecret.trim() } };
  }
  if (eventDefinition(event).origin === "hub") return {};
  const channels =
    eventDefinition(event).provider === "slack"
      ? commaSeparated(eventChannelText(value, event))
      : [];
  return {
    connection: value.connection,
    filters: {
      from_users: users(eventAudience(value, event)),
      ...authoredQualifiers(value, event),
      ...slackMessageFilters(value, event),
      ...(channels.length === 0 ? {} : { channels }),
      ...(event === "slack.message" && value.includeBots ? { include_bots: true } : {}),
      ...(event === "slack.message" && value.directMessages === true
        ? { direct_messages: true }
        : {}),
    },
  };
}

/**
 * Writes one event the form owns. Qualifiers that belonged to the previous event and do not
 * belong to this one are removed, so renaming an event does not keep the old label.
 *
 * @param document - YAML document being patched
 * @param event - Event to write
 * @param value - Current form
 * @param retiredQualifiers - Qualifier keys the previous events used
 * @returns Nothing.
 */
export function writeEvent(
  document: Document,
  event: EditorEvent,
  value: TriggerFormValue,
  retiredQualifiers: readonly QualifierKey[],
): void {
  if (eventDefinition(event).origin === "hub") {
    deleteIfPresent(document, ["on", event, "connection"]);
    deleteIfPresent(document, ["on", event, "filters", "from_users"]);
  } else {
    setIfChanged(document, ["on", event, "connection"], value.connection);
    setIfChanged(
      document,
      ["on", event, "filters", "from_users"],
      users(eventAudience(value, event)),
    );
  }
  setOptional(
    document,
    ["on", event, "recurrence"],
    event === "schedule.tick" ? (value.recurrence ?? DEFAULT_RECURRENCE) : undefined,
  );
  if (event === "schedule.tick") deleteIfPresent(document, ["on", event, "filters"]);
  if (eventDefinition(event).provider === "slack") {
    const channels = commaSeparated(eventChannelText(value, event));
    setOptional(
      document,
      ["on", event, "filters", "channels"],
      channels.length === 0 ? undefined : channels,
    );
  }
  if (event === "slack.message") {
    setOptional(
      document,
      ["on", event, "filters", "include_bots"],
      value.includeBots ? true : undefined,
    );
    setOptional(
      document,
      ["on", event, "filters", "direct_messages"],
      value.directMessages === true ? true : undefined,
    );
  }
  setOptional(
    document,
    ["on", event, "filters", "webhook_secret"],
    event === "webhook.received" ? value.webhookSecret.trim() : undefined,
  );
  if (eventDefinition(event).provider === "slack") {
    writeSlackMessageField(document, event, value.regex?.[event]);
  } else {
    deleteIfPresent(document, ["on", event, "filters", "regex"]);
    deleteIfPresent(document, ["on", event, "filters", "text"]);
  }
  const qualifiers = authoredQualifiers(value, event);
  const qualifierKeys = new Set<QualifierKey>([
    ...retiredQualifiers,
    ...eventDefinition(event).qualifiers.map((qualifier) => qualifier.key),
  ]);
  for (const key of qualifierKeys) {
    setOptional(document, ["on", event, "filters", key], qualifiers[key]);
  }
}

/**
 * Events the form is editing. `event` stays the primary. A stale `events` list that does not
 * contain it means the caller changed the primary and the extra events no longer apply.
 *
 * @param value - Current form
 * @returns The primary event first, then the others
 */
export function selectedTriggerEvents(value: TriggerFormValue): EditorEvent[] {
  if (value.events.length === 0 || !value.events.includes(value.event)) return [value.event];
  return [value.event, ...value.events.filter((event) => event !== value.event)];
}

/**
 * Adds or removes one event that shares the trigger's connection.
 * The first event stays, because the form always has a primary event.
 *
 * @param value - Current form
 * @param event - Event to add or remove
 * @param selected - Whether that event should run the automation
 * @returns The form with the event list updated
 */
export function toggleTriggerEvent(
  value: TriggerFormValue,
  event: EditorEvent,
  selected: boolean,
): TriggerFormValue {
  const current = selectedTriggerEvents(value);
  let next = current.filter((item) => item !== event);
  if (selected) next = current.includes(event) ? current : [...current, event];
  const events = next.length === 0 ? [value.event] : next;
  const primary = events[0] ?? value.event;
  const eventUsers = { ...value.eventUsers };
  const regex = { ...value.regex };
  const eventChannels = { ...value.eventChannels };
  // A newly checked event starts with the primary audience and channel list. Its text filter stays empty.
  if (selected && !current.includes(event)) {
    eventUsers[event] = value.allowedUsers;
    eventChannels[event] = eventChannelText(value, value.event);
  }
  if (!selected) {
    delete eventUsers[event];
    delete regex[event];
    delete eventChannels[event];
  }
  // The primary audience is `allowedUsers`. Promote the next event's own list when it takes over.
  const allowedUsers =
    primary === value.event ? value.allowedUsers : (eventUsers[primary] ?? value.allowedUsers);
  if (primary !== value.event) eventUsers[primary] = allowedUsers;
  const channels = eventChannelText({ ...value, event: primary, eventChannels }, primary);
  return {
    ...value,
    event: primary,
    events,
    allowedUsers,
    channels,
    eventUsers,
    eventChannels,
    regex,
  };
}

/**
 * Channel ids one event listens to. Empty listens to every channel.
 *
 * @param value - Current form
 * @param event - Event being read or written
 * @returns Comma-separated channel ids
 */
export function eventChannelText(value: TriggerFormValue, event: EditorEvent): string {
  return value.eventChannels?.[event] ?? value.channels;
}

/**
 * Sets the channels one event listens to.
 *
 * @param value - Current form
 * @param event - Event whose channels change
 * @param channels - Comma-separated channel ids, or empty for every channel
 * @returns The form with that list stored
 */
export function setEventChannels(
  value: TriggerFormValue,
  event: EditorEvent,
  channels: string,
): TriggerFormValue {
  const eventChannels = { ...value.eventChannels, [event]: channels };
  if (event !== value.event) return { ...value, eventChannels };
  return { ...value, channels, eventChannels };
}

/**
 * People one event listens to. The primary event uses `allowedUsers`. Another event uses its own
 * list when the form has one, and otherwise the primary list.
 *
 * @param value - Current form
 * @param event - Event being read or written
 * @returns Comma-separated user ids, or `*` for everyone
 */
export function eventAudience(value: TriggerFormValue, event: EditorEvent): string {
  if (event === value.event) return value.allowedUsers;
  return value.eventUsers?.[event] ?? value.allowedUsers;
}

/**
 * Sets the people one event listens to.
 *
 * @param value - Current form
 * @param event - Event whose audience changes
 * @param audience - Comma-separated user ids, or `*` for everyone
 * @returns The form with that audience stored
 */
export function setEventAudience(
  value: TriggerFormValue,
  event: EditorEvent,
  audience: string,
): TriggerFormValue {
  const eventUsers = { ...value.eventUsers, [event]: audience };
  if (event !== value.event) return { ...value, eventUsers };
  return { ...value, allowedUsers: audience, eventUsers };
}

/**
 * Gives every selected event the same audience.
 *
 * @param value - Current form
 * @param audience - Comma-separated user ids, or `*` for everyone
 * @returns The form with one shared audience
 */
export function setSharedAudience(value: TriggerFormValue, audience: string): TriggerFormValue {
  const eventUsers = { ...value.eventUsers };
  for (const event of selectedTriggerEvents(value)) eventUsers[event] = audience;
  return { ...value, allowedUsers: audience, eventUsers };
}

/**
 * Sets the message items one Slack event must match.
 *
 * @param value - Current form
 * @param event - Event whose text filter changes
 * @param expressions - One item per line. A line that starts with `regex:` is an expression.
 * Any other line is literal text. Empty when the event does not filter on text.
 * @returns The form with that list stored
 */
export function setEventRegex(
  value: TriggerFormValue,
  event: EditorEvent,
  expressions: string,
): TriggerFormValue {
  return { ...value, regex: { ...value.regex, [event]: expressions } };
}

/**
 * Replaces a YAML node only when the new value differs, so comments on untouched nodes stay.
 *
 * @param document - YAML document being patched
 * @param path - Node path
 * @param value - Next value
 * @returns Nothing.
 */
export function setIfChanged(document: Document, path: readonly string[], value: unknown): void {
  if (JSON.stringify(document.getIn(path)) !== JSON.stringify(value)) document.setIn(path, value);
}

/**
 * Writes a value, or deletes the node when the form has nothing to store there.
 *
 * @param document - YAML document being patched
 * @param path - Node path
 * @param value - Next value, or undefined to remove it
 * @returns Nothing.
 */
export function setOptional(document: Document, path: readonly string[], value: unknown): void {
  if (value === undefined) deleteIfPresent(document, path);
  else setIfChanged(document, path, value);
}

/**
 * Deletes a node that exists. A missing node is left alone.
 *
 * @param document - YAML document being patched
 * @param path - Node path
 * @returns Nothing.
 */
export function deleteIfPresent(document: Document, path: readonly string[]): void {
  if (document.hasIn(path)) document.deleteIn(path);
}

/**
 * Removes a map that the form just emptied, such as `features` after Fast is cleared.
 *
 * @param document - YAML document being patched
 * @param path - Map path
 * @returns Nothing.
 */
export function clearEmptyMap(document: Document, path: readonly string[]): void {
  const value = document.getIn(path, true);
  if (!isEmptyMap(value)) return;
  deleteIfPresent(document, path);
}

/**
 * Splits a comma-separated field. Blank entries are dropped.
 *
 * @param value - Field text
 * @returns Trimmed entries
 */
export function commaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Message items one Slack event requires. An empty field removes `text` and `regex`.
 *
 * @param value - Current form
 * @param event - Event being written
 * @returns The filter keys that event should store, or nothing for other providers
 */
function slackMessageFilters(
  value: TriggerFormValue,
  event: EditorEvent,
): ReturnType<typeof slackFiltersFromField> {
  if (eventDefinition(event).provider !== "slack") return {};
  return slackFiltersFromField(value.regex?.[event]);
}

/**
 * Writes `text` and `regex` for one Slack event.
 *
 * A field that still describes the stored clauses is left alone, so a save that did not edit
 * the message keeps the document's `regex` or `text` bytes. A changed field writes expressions
 * back to `regex` when every line is an expression, and writes `text` when any line is literal.
 *
 * @param document - YAML document being patched
 * @param event - Slack event to write
 * @param field - One item per line, when the form has it
 * @returns Nothing.
 */
function writeSlackMessageField(
  document: Document,
  event: EditorEvent,
  field: string | undefined,
): void {
  const textPath = ["on", event, "filters", "text"] as const;
  const regexPath = ["on", event, "filters", "regex"] as const;
  const projected = slackMessageFieldText({
    text: storedFilterValue(document.getIn(textPath)),
    regex: storedFilterValue(document.getIn(regexPath)),
  });
  if (projected === undefined) return;
  if (sameSlackMessageField(field, projected)) return;
  const filters = slackFiltersFromField(field);
  setOptional(document, textPath, filters.text);
  setOptional(document, regexPath, filters.regex);
}

/**
 * A YAML node as plain JSON. `getIn` returns a YAML sequence, which is not a JavaScript array.
 *
 * @param value - Node from the document, or undefined when the path is missing
 * @returns The JSON value, or undefined when the node is missing
 */
function storedFilterValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return undefined;
  const parsed: unknown = JSON.parse(encoded);
  return parsed;
}

/**
 * Whether the message field still describes the clauses the document already stores.
 *
 * @param field - Current field text
 * @param projected - Field text read from the document
 * @returns True when a save should leave `text` and `regex` untouched
 */
function sameSlackMessageField(field: string | undefined, projected: string): boolean {
  return (
    JSON.stringify(parseSlackMessageField(field ?? "")) ===
    JSON.stringify(parseSlackMessageField(projected))
  );
}

/**
 * People a Slack or GitHub event listens to. An empty field means everyone.
 *
 * @param value - Comma-separated user ids
 * @returns User ids, or `["*"]` when the field is blank
 */
export function users(value: string): string[] {
  const values = commaSeparated(value);
  return values.length === 0 ? ["*"] : values;
}

/**
 * Turns a blank field into an absent YAML value.
 *
 * @param value - Field text
 * @returns Trimmed text, or undefined when it is blank
 */
export function blankToUndefined(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

/**
 * Qualifier values already stored on an event.
 *
 * @param event - Event whose qualifiers to read
 * @param filters - Event filters, when the document has them
 * @returns Qualifiers the form can edit
 */
export function readQualifiers(
  event: EditorEvent,
  filters: TriggerDocument["on"][string]["filters"],
): QualifierValues {
  const values: QualifierValues = {};
  for (const qualifier of eventDefinition(event).qualifiers) {
    const value = filters?.[qualifier.key];
    if (value !== undefined) values[qualifier.key] = value;
  }
  return values;
}

/**
 * Qualifier values the form is about to write for one event.
 *
 * @param value - Current form
 * @param event - Event being written
 * @returns Qualifiers that event owns
 */
function authoredQualifiers(value: TriggerFormValue, event: EditorEvent): QualifierValues {
  const filters: QualifierValues = {};
  for (const qualifier of eventDefinition(event).qualifiers) {
    const selection = value.qualifiers[qualifier.key];
    if (selection !== undefined) filters[qualifier.key] = selection.trim();
  }
  return filters;
}

/**
 * True when a YAML map has no entries left.
 *
 * @param value - Node from the document
 * @returns Whether the map is empty
 */
function isEmptyMap(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if ("items" in value && Array.isArray(value.items)) return value.items.length === 0;
  return Object.keys(value).length === 0;
}
