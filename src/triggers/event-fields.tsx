/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- event controls bind their own configuration */
import { CheckboxField } from "../components/app/checkbox-field.js";
import { FormField } from "../components/app/form-field.js";
import { CopyButton } from "../components/app/copy-field.js";
import { eventDefinition, type QualifierKey } from "./configuration/events.js";
import { type TriggerFieldErrors, type TriggerFormValue } from "./configuration/editor.js";
import { selectedTriggerEvents, setEventTerms } from "./configuration/form-events.js";
import { ScheduleFields } from "./schedule/fields.js";
import { SlackChannelPicker } from "./slack/channel-picker.js";

/** Source-specific controls live behind the event form boundary. */
export function EventFields({
  value,
  errors,
  organizationSlug,
  onChange,
}: {
  value: TriggerFormValue;
  errors: TriggerFieldErrors;
  organizationSlug: string;
  onChange: (value: TriggerFormValue) => void;
}) {
  const updateQualifier = (key: QualifierKey, next: string) =>
    onChange({ ...value, qualifiers: { ...value.qualifiers, [key]: next } });
  const events = selectedTriggerEvents(value);
  const slack = events.some((event) => eventDefinition(event).provider === "slack");
  return (
    <>
      <ScheduleFields
        event={value.event}
        value={value.recurrence}
        error={errors.recurrence}
        onChange={(recurrence) => onChange({ ...value, recurrence })}
      />
      {slack ? (
        <FormField
          id="trigger-channels"
          label="Channels"
          description="Leave empty to include every channel."
        >
          {(control) => (
            <SlackChannelPicker
              control={control}
              organizationSlug={organizationSlug}
              connection={value.connection}
              value={value.channels}
              onChange={(channels) => onChange({ ...value, channels })}
            />
          )}
        </FormField>
      ) : null}
      {events.includes("slack.message") ? (
        <CheckboxField
          id="trigger-include-bots"
          label="Include bot messages"
          description="Run when another app posts in the channel."
          checked={value.includeBots}
          onChange={(includeBots) => onChange({ ...value, includeBots })}
        />
      ) : null}
      <MessageTextFields value={value} onChange={onChange} />
      {value.event === "webhook.received" ? <WebhookFields value={value} errors={errors} /> : null}
      {eventDefinition(value.event).provider === "slack" ? (
        <p className="text-sm text-muted-foreground">Send to Slack is on.</p>
      ) : null}
      {eventDefinition(value.event).qualifiers.map((qualifier) => {
        const error = errors[`qualifiers.${qualifier.key}`];
        return (
          <FormField
            key={qualifier.key}
            id={`trigger-qualifier-${qualifier.key}`}
            name={qualifier.key}
            label={qualifier.label}
            description={qualifier.description}
            kind="text"
            value={value.qualifiers[qualifier.key] ?? ""}
            onChange={(next) => updateQualifier(qualifier.key, next)}
            required={qualifier.required}
            {...(error === undefined ? {} : { error })}
          />
        );
      })}
    </>
  );
}

/**
 * Terms a Slack event looks for in the message. Hidden when none of the selected events use them,
 * so a trigger that matches every message stays as it was.
 */
function MessageTextFields({
  value,
  onChange,
}: {
  value: TriggerFormValue;
  onChange: (value: TriggerFormValue) => void;
}) {
  const events = selectedTriggerEvents(value).filter(
    (event) => eventDefinition(event).provider === "slack",
  );
  const visible = events.some((event) => hasTerms(value, event));
  if (!visible) return null;
  return (
    <div className="grid gap-4">
      {events.map((event) => (
        <div key={event} className="grid gap-4">
          {events.length > 1 ? (
            <p className="text-sm text-muted-foreground">{eventDefinition(event).label}</p>
          ) : null}
          <FormField
            id={`trigger-contains-all-${event}`}
            label="Must contain all"
            description="Comma-separated. Every term has to appear."
            kind="text"
            name={`contains-all-${event}`}
            value={value.containsAll?.[event] ?? ""}
            onChange={(terms) => onChange(setEventTerms(value, event, "containsAll", terms))}
          />
          <FormField
            id={`trigger-contains-any-${event}`}
            label="Must contain one of"
            description="Comma-separated. One term is enough."
            kind="text"
            name={`contains-any-${event}`}
            value={value.containsAny?.[event] ?? ""}
            onChange={(terms) => onChange(setEventTerms(value, event, "containsAny", terms))}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Whether this event already filters on message text.
 *
 * @param value - Current form
 * @param event - Event to inspect
 * @returns True when either term list has text
 */
function hasTerms(value: TriggerFormValue, event: TriggerFormValue["event"]): boolean {
  const required = value.containsAll?.[event]?.trim() ?? "";
  const accepted = value.containsAny?.[event]?.trim() ?? "";
  return required.length > 0 || accepted.length > 0;
}

function WebhookFields({ value, errors }: { value: TriggerFormValue; errors: TriggerFieldErrors }) {
  const url = webhookUrl(value.webhookSecret);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField
        id="trigger-webhook-url"
        name="webhookUrl"
        label="URL"
        description="Send a POST request to this address."
        kind="text"
        value={url}
        onChange={() => undefined}
        disabled
        {...(errors.webhookSecret === undefined ? {} : { error: errors.webhookSecret })}
      />
      <div className="flex items-end">
        <CopyButton label="Webhook URL" value={url} />
      </div>
    </div>
  );
}

function webhookUrl(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length === 0) return "";
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/api/automations/hooks/${trimmed}`;
}
