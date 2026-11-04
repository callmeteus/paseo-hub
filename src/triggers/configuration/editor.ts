import {
  recurrenceSummary,
  RecurrenceSchema,
  DEFAULT_RECURRENCE,
  type Recurrence,
} from "../schedule/recurrence.js";
import { ContinuationSchema } from "../continuation.js";
import { parseDocument, stringify, type Document } from "yaml";
import { z } from "zod";
import { IDENTIFIER, TriggerDocumentSchema, type TriggerDocument } from "./schema.js";

import {
  eventDefinition,
  isEditorEvent,
  type EditorEvent,
  type QualifierKey,
  type QualifierValues,
} from "./events.js";
import {
  blankToUndefined,
  clearEmptyMap,
  commaSeparated,
  cursorFastValue,
  eventAudience,
  formEventDefinition,
  projectEditorEvents,
  type ProjectedEvents,
  readQualifiers,
  selectedTriggerEvents,
  setIfChanged,
  setOptional,
  writeEvent,
} from "./form-events.js";

export interface TriggerFormValue {
  name: string;
  enabled: boolean;
  event: EditorEvent;
  /** Every event this trigger runs for. The first one is `event`. */
  events: EditorEvent[];
  /** Slack messages from other apps. Written on `slack.message` only. */
  includeBots: boolean;
  connection: string;
  allowedUsers: string;
  /** People each event listens to. The primary event also uses `allowedUsers`. */
  eventUsers?: Partial<Record<EditorEvent, string>>;
  /** Comma-separated substrings that must all appear in that event's text. */
  containsAll?: Partial<Record<EditorEvent, string>>;
  /** Comma-separated substrings of which one must appear in that event's text. */
  containsAny?: Partial<Record<EditorEvent, string>>;
  qualifiers: QualifierValues;
  recurrence?: Recurrence;
  daemon: string;
  cwd: string;
  agent: string;
  mode: string;
  thinkingOptionId: string;
  /** Cursor Fast. "false" and "true" are the feature values; empty means the workflow does not set it. */
  cursorFast: string;
  providerOptions: string;
  continuationMode: string;
  continuationKey: string;
  maxRuntime: string;
  idleTimeout: string;
  githubConnection: string;
  githubRepositories: string;
  githubPermissions: string;
  githubDuration: string;
  prompt: string;
  channels: string;
  webhookSecret: string;
}

export type TriggerFormProjection =
  | { status: "editable"; value: TriggerFormValue }
  | { status: "yaml_only"; reason: string };

const ProviderOptionsSchema = z.record(z.string(), z.unknown());
const GitHubPermissionsSchema = z.record(z.string(), z.enum(["read", "write", "admin"]));

export function projectTriggerForm(yaml: string): TriggerFormProjection {
  const parsed = parseEditorDocument(yaml);
  if (!parsed.success) return { status: "yaml_only", reason: parsed.error };
  const trigger = parsed.data;
  const projected = projectEditorEvents(trigger);
  if (projected.status !== "editable") return projected;
  if ("choices" in trigger.run.agent) {
    return { status: "yaml_only", reason: "Agent choices can only be edited in YAML." };
  }
  const agent = trigger.run.agent;
  const fast = agent.features?.["fast"];
  if (fast !== undefined && fast !== "true" && fast !== "false") {
    return { status: "yaml_only", reason: "The form cannot edit that Fast setting." };
  }
  return {
    status: "editable",
    value: toFormValue(trigger, projected, agent),
  };
}

function toFormValue(
  trigger: TriggerDocument,
  projected: ProjectedEvents,
  agent: Extract<TriggerDocument["run"]["agent"], { provider: string }>,
): TriggerFormValue {
  const event = projected.events[0];
  if (event === undefined) {
    throw new Error("The form supports at least one event.");
  }
  const definition = trigger.on[event];
  if (definition === undefined) {
    throw new Error("The form supports at least one event.");
  }
  return {
    name: trigger.name,
    enabled: trigger.enabled,
    event,
    events: projected.events,
    includeBots: projected.includeBots,
    eventUsers: projected.eventUsers,
    containsAll: projected.containsAll,
    containsAny: projected.containsAny,
    ...eventFormFields(event, definition),
    ...runFormFields(trigger, agent),
  };
}

function eventFormFields(
  event: EditorEvent,
  definition: TriggerDocument["on"][string],
): Pick<
  TriggerFormValue,
  "connection" | "allowedUsers" | "qualifiers" | "recurrence" | "channels" | "webhookSecret"
> {
  return {
    connection: definition.connection ?? "",
    allowedUsers: definition.filters?.from_users?.join(", ") ?? "*",
    qualifiers: readQualifiers(event, definition.filters),
    recurrence: definition.recurrence ?? DEFAULT_RECURRENCE,
    channels: definition.filters?.channels?.join(", ") ?? "",
    webhookSecret: definition.filters?.webhook_secret ?? "",
  };
}

function runFormFields(
  trigger: TriggerDocument,
  agent: Extract<TriggerDocument["run"]["agent"], { provider: string }>,
): Pick<
  TriggerFormValue,
  | "daemon"
  | "cwd"
  | "agent"
  | "mode"
  | "thinkingOptionId"
  | "cursorFast"
  | "providerOptions"
  | "continuationMode"
  | "continuationKey"
  | "maxRuntime"
  | "idleTimeout"
  | "githubConnection"
  | "githubRepositories"
  | "githubPermissions"
  | "githubDuration"
  | "prompt"
> {
  return {
    daemon: trigger.run.target.daemon,
    cwd: trigger.run.target.cwd,
    agent: joinAgentId(agent.provider, agent.model),
    mode: agent.mode ?? "",
    thinkingOptionId: agent.thinkingOptionId ?? "",
    cursorFast: cursorFastValue(agent),
    providerOptions: agent.options === undefined ? "" : JSON.stringify(agent.options, null, 2),
    continuationMode: trigger.run.continuation.mode,
    continuationKey: trigger.run.continuation.mode === "key" ? trigger.run.continuation.key : "",
    maxRuntime: trigger.run.max_runtime,
    idleTimeout: trigger.run.idle_timeout,
    githubConnection: trigger.run.github?.connection ?? "",
    githubRepositories: trigger.run.github?.repositories?.join(", ") ?? "",
    githubPermissions:
      trigger.run.github?.permissions === undefined
        ? ""
        : JSON.stringify(trigger.run.github.permissions, null, 2),
    githubDuration: trigger.run.github?.duration ?? "",
    prompt: trigger.run.prompt,
  };
}

/** Patch only form-owned YAML nodes, retaining comments, ordering, and advanced nodes. */
export function patchTriggerYaml(yaml: string, value: TriggerFormValue): string {
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  if (sameFormValue(projection.value, value)) return yaml;
  validateFormValue(value);

  const document = parseDocument(yaml, { compat: ["timestamp"] });
  assertDocument(document);
  setIfChanged(document, ["name"], value.name);
  setIfChanged(document, ["enabled"], value.enabled);

  const previousEvents = selectedTriggerEvents(projection.value);
  const nextEvents = selectedTriggerEvents(value);
  // A one-for-one change keeps the old node, including filters the form does not draw.
  const [previousOnly] = previousEvents;
  const [nextOnly] = nextEvents;
  if (
    previousEvents.length === 1 &&
    nextEvents.length === 1 &&
    previousOnly !== undefined &&
    nextOnly !== undefined &&
    previousOnly !== nextOnly
  ) {
    const definition = document.getIn(["on", previousOnly], true);
    document.deleteIn(["on", previousOnly]);
    document.setIn(["on", nextOnly], definition ?? {});
  }
  for (const event of previousEvents) {
    if (!nextEvents.includes(event)) document.deleteIn(["on", event]);
  }
  const retiredQualifiers = previousEvents.flatMap((event) =>
    eventDefinition(event).qualifiers.map((qualifier) => qualifier.key),
  );
  for (const event of nextEvents) writeEvent(document, event, value, retiredQualifiers);

  setIfChanged(document, ["run", "target", "daemon"], value.daemon);
  setIfChanged(document, ["run", "target", "cwd"], value.cwd);
  const agent = splitAgentId(value.agent);
  setIfChanged(document, ["run", "agent", "provider"], agent.provider);
  setOptional(document, ["run", "agent", "model"], agent.model);
  setIfChanged(document, ["run", "agent", "mode"], value.mode.trim());
  setOptional(
    document,
    ["run", "agent", "thinkingOptionId"],
    blankToUndefined(value.thinkingOptionId),
  );
  setOptional(
    document,
    ["run", "agent", "features", "fast"],
    agent.provider === "cursor" ? blankToUndefined(value.cursorFast) : undefined,
  );
  clearEmptyMap(document, ["run", "agent", "features"]);
  setOptional(document, ["run", "agent", "options"], parseProviderOptions(value.providerOptions));
  setIfChanged(document, ["run", "continuation"], formContinuation(value));
  setIfChanged(document, ["run", "max_runtime"], value.maxRuntime.trim());
  setIfChanged(document, ["run", "idle_timeout"], value.idleTimeout.trim());
  setOptional(document, ["run", "github"], githubAuthority(value));
  setIfChanged(document, ["run", "prompt"], value.prompt);
  return document.toString({ lineWidth: 0 });
}

export type TriggerYamlResult =
  | { status: "ok"; yaml: string }
  | { status: "incomplete"; reason: string };

/**
 * The YAML a form amounts to: the canonical document patched where one exists, a fresh document
 * where it does not.
 *
 * A half-filled trigger has no document at all — `run.target.daemon` and `run.agent.provider` have
 * no empty representation — so the caller is told which field is still missing. Handing back a
 * reason rather than throwing is what lets a screen disable the YAML view and say why beside the
 * control, instead of surfacing a stray exception somewhere far from the field that caused it.
 */
export function mergeTriggerForm(yaml: string, value: TriggerFormValue): TriggerYamlResult {
  try {
    return {
      status: "ok",
      yaml:
        projectTriggerForm(yaml).status === "editable"
          ? patchTriggerYaml(yaml, value)
          : createTriggerYaml(value),
    };
  } catch (cause) {
    return { status: "incomplete", reason: incompleteReason(cause) };
  }
}

function incompleteReason(cause: unknown): string {
  return cause instanceof Error && cause.message.trim() !== ""
    ? cause.message
    : "The trigger is invalid.";
}

export function createTriggerYaml(value: TriggerFormValue): string {
  validateFormValue(value);
  const agent = splitAgentId(value.agent);
  const providerOptions = parseProviderOptions(value.providerOptions);
  const github = githubAuthority(value);
  return stringify(
    {
      name: value.name,
      enabled: value.enabled,
      on: Object.fromEntries(
        selectedTriggerEvents(value).map((event) => [event, formEventDefinition(value, event)]),
      ),
      run: {
        target: { daemon: value.daemon, cwd: value.cwd },
        agent: {
          provider: agent.provider,
          ...(agent.model === undefined ? {} : { model: agent.model }),
          mode: value.mode.trim(),
          ...(blankToUndefined(value.thinkingOptionId) === undefined
            ? {}
            : { thinkingOptionId: value.thinkingOptionId.trim() }),
          ...(agent.provider === "cursor" && blankToUndefined(value.cursorFast) !== undefined
            ? { features: { fast: value.cursorFast.trim() } }
            : {}),
          ...(providerOptions === undefined ? {} : { options: providerOptions }),
        },
        continuation: formContinuation(value),
        max_runtime: value.maxRuntime.trim(),
        idle_timeout: value.idleTimeout.trim(),
        ...(github === undefined ? {} : { github }),
        prompt: value.prompt,
      },
    },
    { lineWidth: 0, compat: ["timestamp"] },
  );
}

function workingDirectoryErrors(value: TriggerFormValue): TriggerFieldErrors {
  const cwd = value.cwd.trim();
  if (cwd.length === 0) return { cwd: "Working directory is required." };
  return cwd.startsWith("/") ? {} : { cwd: "Working directory must be an absolute path." };
}

function webhookErrors(value: TriggerFormValue): TriggerFieldErrors {
  if (value.event !== "webhook.received" || value.webhookSecret.trim().length >= 32) return {};
  return { webhookSecret: "Webhook secret is missing." };
}

function recurrenceErrors(value: TriggerFormValue): TriggerFieldErrors {
  if (value.event !== "schedule.tick") return {};
  const parsed = RecurrenceSchema.safeParse(value.recurrence ?? DEFAULT_RECURRENCE);
  return parsed.success ? {} : { recurrence: parsed.error.issues[0]!.message };
}

function githubAuthority(value: TriggerFormValue) {
  const connection = blankToUndefined(value.githubConnection);
  if (connection === undefined) return undefined;
  const repositories = commaSeparated(value.githubRepositories);
  const permissions = parsePermissions(value.githubPermissions);
  const duration = blankToUndefined(value.githubDuration);
  return {
    connection,
    ...(repositories.length === 0 ? {} : { repositories }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(duration === undefined ? {} : { duration }),
  };
}

function parsePermissions(value: string): Record<string, "read" | "write" | "admin"> | undefined {
  if (value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GitHub permissions must be valid JSON.");
  }
  const permissions = GitHubPermissionsSchema.safeParse(parsed);
  if (!permissions.success) {
    throw new Error('GitHub permissions map a scope to "read", "write", or "admin".');
  }
  return permissions.data;
}

/** What is wrong with each field, keyed by the field that has to change. */
export type TriggerFieldErrors = Partial<
  Record<keyof TriggerFormValue | `qualifiers.${QualifierKey}`, string>
>;

/**
 * Every reason this form cannot become a trigger document, addressed to the field that owns it.
 *
 * One list, because a form that refuses to submit and a form that marks its fields have to agree
 * about why: the same call feeds the errors drawn beside each control and the single sentence
 * `mergeTriggerForm` reports when the document cannot be written at all. Insertion order is the
 * order the fields appear on screen, so "the first problem" is the topmost one.
 */
export function triggerFormErrors(value: TriggerFormValue): TriggerFieldErrors {
  const errors: TriggerFieldErrors = {};
  const name = value.name.trim();
  if (name.length === 0) errors.name = "Trigger name is required.";
  else if (!IDENTIFIER.test(name)) {
    errors.name = "Use lowercase letters, digits, and hyphens, starting with a letter.";
  }
  if (eventDefinition(value.event).origin === "provider") {
    if (value.connection.trim().length === 0) errors.connection = "Connection is required.";
  }
  Object.assign(errors, audienceErrors(value));
  for (const qualifier of eventDefinition(value.event).qualifiers) {
    const selection = value.qualifiers[qualifier.key];
    if (qualifier.required && (selection === undefined || selection.trim().length === 0)) {
      errors[`qualifiers.${qualifier.key}`] = `${qualifier.label} is required.`;
    }
  }
  Object.assign(errors, webhookErrors(value), recurrenceErrors(value));
  if (value.daemon.trim().length === 0) errors.daemon = "Daemon is required.";
  Object.assign(errors, workingDirectoryErrors(value));
  if (value.maxRuntime.trim().length === 0) errors.maxRuntime = "Maximum runtime is required.";
  if (value.idleTimeout.trim().length === 0) errors.idleTimeout = "Idle timeout is required.";
  const agent = refused(() => splitAgentId(value.agent));
  if (agent !== undefined) errors.agent = agent;
  if (value.mode.trim().length === 0) errors.mode = "Execution mode is required.";
  const options = refused(() => parseProviderOptions(value.providerOptions));
  if (options !== undefined) errors.providerOptions = options;
  if (value.githubConnection.trim().length !== 0) {
    const permissions = refused(() => parsePermissions(value.githubPermissions));
    if (permissions !== undefined) errors.githubPermissions = permissions;
  }
  Object.assign(errors, continuationErrors(value));
  if (value.prompt.trim().length === 0) errors.prompt = "Instructions are required.";
  return errors;
}

/**
 * The audience error, when any selected event listens to nobody.
 *
 * @param value - Current form
 * @returns The user-id error, or an empty list
 */
function audienceErrors(value: TriggerFormValue): TriggerFieldErrors {
  for (const event of selectedTriggerEvents(value)) {
    if (eventDefinition(event).origin !== "provider") continue;
    if (eventAudience(value, event).trim().length === 0) {
      return { allowedUsers: "Name at least one user ID, or let everyone trigger it." };
    }
  }
  return {};
}

/** The message a parse refused with, or `undefined` when it accepted the value. */
function refused(parse: () => unknown): string | undefined {
  try {
    parse();
    return undefined;
  } catch (cause) {
    return incompleteReason(cause);
  }
}

function validateFormValue(value: TriggerFormValue): void {
  const [message] = Object.values(triggerFormErrors(value));
  if (message !== undefined) throw new Error(message);
}

export function parseProviderOptions(value: string): Record<string, unknown> | undefined {
  if (value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Provider options must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Provider options must be a JSON object.");
  }
  return ProviderOptionsSchema.parse(parsed);
}

export function joinAgentId(provider: string, model: string | undefined): string {
  return model === undefined ? provider : `${provider}/${model}`;
}

export function splitAgentId(value: string): { provider: string; model?: string } {
  const normalized = value.trim();
  const separator = normalized.indexOf("/");
  if (separator < 0) {
    if (normalized.length === 0) throw new Error("Agent is required.");
    return { provider: normalized };
  }
  const provider = normalized.slice(0, separator).trim();
  const model = normalized.slice(separator + 1).trim();
  if (provider.length === 0 || model.length === 0) {
    throw new Error("Agent must look like provider/model.");
  }
  return { provider, model };
}

function parseEditorDocument(
  yaml: string,
): { success: true; data: TriggerDocument } | { success: false; error: string } {
  const document = parseDocument(yaml, { compat: ["timestamp"] });
  if (document.errors.length > 0) return { success: false, error: document.errors[0]!.message };
  const parsed = TriggerDocumentSchema.safeParse(document.toJS());
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { success: false, error: `${issue.path.join(".") || "YAML"}: ${issue.message}` };
  }
  return { success: true, data: parsed.data };
}

function assertDocument(document: Document): void {
  if (document.errors.length > 0) throw new Error(document.errors[0]!.message);
}

function sameFormValue(left: TriggerFormValue, right: TriggerFormValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Provider-bound state and qualifier compatibility belong to the form model. */
export function changeTriggerEvent(value: TriggerFormValue, event: EditorEvent): TriggerFormValue {
  const previous = eventDefinition(value.event);
  const next = eventDefinition(event);
  const sameProvider = previous.provider === next.provider;
  const qualifiers: QualifierValues = {};
  if (sameProvider) {
    for (const qualifier of next.qualifiers) {
      if (
        previous.qualifiers.some(
          (candidate) => candidate.key === qualifier.key && candidate.kind === qualifier.kind,
        )
      ) {
        const selection = value.qualifiers[qualifier.key];
        if (selection !== undefined) qualifiers[qualifier.key] = selection;
      }
    }
  }
  const webhookSecret =
    event === "webhook.received" && value.webhookSecret.trim().length === 0
      ? createWebhookSecret()
      : value.webhookSecret;
  // Message text belongs to the event that moved. A different provider does not keep it.
  const carriedTerms = sameProvider && next.provider === "slack";
  return {
    ...value,
    event,
    events: [event],
    eventUsers: { [event]: value.allowedUsers },
    containsAll: carriedTerms ? { [event]: value.containsAll?.[value.event] ?? "" } : {},
    containsAny: carriedTerms ? { [event]: value.containsAny?.[value.event] ?? "" } : {},
    qualifiers,
    connection: sameProvider ? value.connection : "",
    webhookSecret,
  };
}

export function createWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const AUTOMATION_TEMPLATE_IDS = [
  "slack-mention",
  "slack-message",
  "github-pull-request",
  "schedule",
  "webhook",
] as const;

export type AutomationTemplateId = (typeof AUTOMATION_TEMPLATE_IDS)[number];

export function isAutomationTemplateId(value: string | null): value is AutomationTemplateId {
  return AUTOMATION_TEMPLATE_IDS.some((id) => id === value);
}

export function applyAutomationTemplate(
  form: TriggerFormValue,
  template: AutomationTemplateId,
): TriggerFormValue {
  const next = changeTriggerEvent(form, AUTOMATION_TEMPLATE_EVENTS[template]);
  return {
    ...next,
    name: AUTOMATION_TEMPLATE_NAMES[template],
    prompt: AUTOMATION_TEMPLATE_PROMPTS[template],
  };
}

const AUTOMATION_TEMPLATE_EVENTS = {
  "slack-mention": "slack.mention",
  "slack-message": "slack.message",
  "github-pull-request": "github.pull_request_created",
  schedule: "schedule.tick",
  webhook: "webhook.received",
} as const satisfies Record<AutomationTemplateId, EditorEvent>;

const AUTOMATION_TEMPLATE_NAMES = {
  "slack-mention": "slack-mention",
  "slack-message": "slack-message",
  "github-pull-request": "github-pull-request",
  schedule: "schedule",
  webhook: "webhook",
} as const satisfies Record<AutomationTemplateId, string>;

const AUTOMATION_TEMPLATE_PROMPTS = {
  "slack-mention":
    "Read the Slack mention and reply in the thread with a useful answer.\n\n${{ paseo.prompt }}",
  "slack-message":
    "Read the new channel message and reply in the thread when you can help.\n\n${{ paseo.prompt }}",
  "github-pull-request":
    "Read the pull request and leave a short review comment.\n\n${{ paseo.prompt }}",
  schedule: "Run the scheduled task.\n\n${{ paseo.prompt }}",
  webhook: "Read the webhook body and do what it asks.\n\n${{ paseo.prompt }}",
} as const satisfies Record<AutomationTemplateId, string>;

function formContinuation(value: TriggerFormValue) {
  return ContinuationSchema.parse(
    value.continuationMode === "key"
      ? { mode: "key", key: value.continuationKey }
      : { mode: value.continuationMode },
  );
}

function continuationErrors(value: TriggerFormValue): TriggerFieldErrors {
  return refused(() => formContinuation(value)) === undefined
    ? {}
    : { continuationKey: "Enter a continuation key or expression." };
}

/**
 * A trigger's event as a list row reads it: the kind first, so a schedule never passes for a
 * manual run, then what narrows it — when a schedule fires, or which connection an event
 * arrives through.
 */
export function describeTriggerEvent(
  value: TriggerFormValue | null,
  event: string,
): { kind: string; detail?: string } {
  const kind = isEditorEvent(event) ? eventDefinition(event).label : event;
  if (value?.event === "schedule.tick") {
    return { kind, detail: recurrenceSummary(value.recurrence ?? DEFAULT_RECURRENCE) };
  }
  if (value === null || value.connection === "") return { kind };
  return { kind, detail: value.connection };
}
