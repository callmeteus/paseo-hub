/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- event controls bind their own configuration */
import { FormField } from "../components/app/form-field.js";
import { CopyButton } from "../components/app/copy-field.js";
import { eventDefinition, type QualifierKey } from "./configuration/events.js";
import type { TriggerFieldErrors, TriggerFormValue } from "./configuration/editor.js";
import { ScheduleFields } from "./schedule/fields.js";

/** Source-specific controls live behind the event form boundary. */
export function EventFields({
  value,
  errors,
  onChange,
}: {
  value: TriggerFormValue;
  errors: TriggerFieldErrors;
  onChange: (value: TriggerFormValue) => void;
}) {
  const updateQualifier = (key: QualifierKey, next: string) =>
    onChange({ ...value, qualifiers: { ...value.qualifiers, [key]: next } });
  return (
    <>
      <ScheduleFields
        event={value.event}
        value={value.recurrence}
        error={errors.recurrence}
        onChange={(recurrence) => onChange({ ...value, recurrence })}
      />
      {value.event === "slack.message" ? (
        <FormField
          id="trigger-channels"
          name="channels"
          label="Channels"
          description="Comma-separated channel IDs. Leave empty for every channel the bot is in."
          kind="text"
          value={value.channels}
          onChange={(channels) => onChange({ ...value, channels })}
        />
      ) : null}
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
