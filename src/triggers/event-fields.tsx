/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- event controls bind their own configuration */
import { CheckboxField } from "../components/app/checkbox-field.js";
import { FormField } from "../components/app/form-field.js";
import { CopyButton } from "../components/app/copy-field.js";
import { eventDefinition, type QualifierKey } from "./configuration/events.js";
import { type TriggerFieldErrors, type TriggerFormValue } from "./configuration/editor.js";
import { selectedTriggerEvents, setEventRegex } from "./configuration/form-events.js";
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
 * Expressions a Slack event matches against the raw message. Empty means no text filter.
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
  if (events.length === 0) return null;
  return (
    <div className="grid gap-4">
      {events.map((event) => (
        <div key={event} className="grid gap-4">
          {events.length > 1 ? (
            <p className="text-sm text-muted-foreground">{eventDefinition(event).label}</p>
          ) : null}
          <FormField
            id={`trigger-regex-${event}`}
            label="Patterns"
            description="One item per line. A line is literal text. Start a line with regex: to use a regular expression. Every line has to match. Leave empty to match any message."
            kind="multiline"
            name={`regex-${event}`}
            value={value.regex?.[event] ?? ""}
            onChange={(expressions) => onChange(setEventRegex(value, event, expressions))}
          />
        </div>
      ))}
    </div>
  );
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
