/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- each audience row binds that event */
import { FormField } from "../components/app/form-field.js";
import { SegmentedControl, type SegmentedOption } from "../components/app/segmented-control.js";
import { eventDefinition } from "./configuration/events.js";
import type { TriggerFormValue } from "./configuration/editor.js";
import {
  eventAudience,
  selectedTriggerEvents,
  setEventAudience,
  setSharedAudience,
} from "./configuration/form-events.js";

const AUDIENCE_OPTIONS: readonly SegmentedOption[] = [
  { value: "everyone", label: "Everyone" },
  { value: "specific", label: "Specific people" },
];

/**
 * Who may start each event. One control when every event listens to the same people, and one
 * control per event when they do not.
 */
export function AudienceFields({
  form,
  onChange,
}: {
  form: TriggerFormValue;
  onChange: (value: TriggerFormValue) => void;
}) {
  const events = selectedTriggerEvents(form).filter(
    (event) => eventDefinition(event).origin === "provider",
  );
  const [first] = events;
  if (first === undefined) return null;
  const firstAudience = eventAudience(form, first);
  const shared = events.every((event) => eventAudience(form, event) === firstAudience);
  if (shared) {
    return (
      <AudienceRow
        id="trigger"
        label="Audience"
        audience={form.allowedUsers}
        onChange={(audience) => onChange(setSharedAudience(form, audience))}
      />
    );
  }
  return (
    <div className="grid gap-4">
      {events.map((event) => (
        <AudienceRow
          key={event}
          id={`trigger-${event}`}
          label={eventDefinition(event).label}
          audience={eventAudience(form, event)}
          onChange={(audience) => onChange(setEventAudience(form, event, audience))}
        />
      ))}
    </div>
  );
}

function AudienceRow({
  id,
  label,
  audience,
  onChange,
}: {
  id: string;
  label: string;
  audience: string;
  onChange: (audience: string) => void;
}) {
  const everyone = audience.trim() === "*";
  const error =
    audience.trim().length === 0
      ? "Name at least one user ID, or let everyone trigger it."
      : undefined;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField id={`${id}-audience`} label={label}>
        {() => (
          <SegmentedControl
            label={label}
            value={everyone ? "everyone" : "specific"}
            options={AUDIENCE_OPTIONS}
            onChange={(choice) => onChange(audienceAfterChoice(audience, choice))}
          />
        )}
      </FormField>
      {everyone ? null : (
        <FormField
          id={`${id}-users`}
          label="User IDs"
          description="Comma-separated provider user IDs."
          kind="text"
          name="allowedUsers"
          value={audience}
          onChange={onChange}
          required
          {...(error === undefined ? {} : { error })}
        />
      )}
    </div>
  );
}

/**
 * Everyone clears the list. Choosing specific people starts blank when the event currently
 * listens to everyone, so the field does not keep a literal star.
 *
 * @param audience - Current audience
 * @param choice - Segment the reader picked
 * @returns The audience to store
 */
function audienceAfterChoice(audience: string, choice: string): string {
  if (choice === "everyone") return "*";
  if (audience.trim() === "*") return "";
  return audience;
}
