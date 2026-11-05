/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop -- each rail binds its own id and options */
import { Plus, Trash2 } from "lucide-react";

import { Combobox, type ComboboxOption } from "../components/app/combobox.js";
import { FormField } from "../components/app/form-field.js";
import { Button } from "../components/ui/button.js";
import { GUARDRAIL_IDS } from "../workflows/guardrails.js";
import type { GuardrailDraft } from "./configuration/form-drafts.js";

const GUARDRAIL_OPTIONS = [
  {
    value: GUARDRAIL_IDS[0],
    label: "Same channel",
    detail: "Refuse a Slack post in another channel.",
  },
  {
    value: GUARDRAIL_IDS[1],
    label: "Same thread",
    detail: "Refuse a Slack post in another thread.",
  },
] as const satisfies readonly ComboboxOption[];

/**
 * `run.guardrails`. Each row is one `{ id, options }`. Adding, removing, and
 * changing a row is the whole editor. These two rails take no options.
 */
export function GuardrailFields({
  value,
  error,
  onChange,
}: {
  value: readonly GuardrailDraft[];
  error?: string;
  onChange: (value: GuardrailDraft[]) => void;
}) {
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        A Slack post that leaves the triggering channel or thread is refused before Hub sends it.
      </p>
      {value.map((rail, index) => (
        <div key={`${rail.id}-${String(index)}`} className="flex items-start gap-2">
          <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2">
            <FormField
              id={`trigger-guardrail-${String(index)}`}
              label="Guardrail"
              description="Which post this rail refuses."
            >
              {(control) => (
                <Combobox
                  {...control}
                  value={rail.id}
                  options={GUARDRAIL_OPTIONS}
                  placeholder="Select a guardrail"
                  empty="No guardrails found."
                  onChange={(option) => onChange(updateRail(value, index, { id: option.value }))}
                />
              )}
            </FormField>
            <FormField
              id={`trigger-guardrail-options-${String(index)}`}
              label="Options"
              description="Leave empty, or {}. Anything else is rejected."
              kind="text"
              name={`guardrail-options-${String(index)}`}
              value={rail.options}
              onChange={(options) => onChange(updateRail(value, index, { options }))}
              {...(error !== undefined && index === 0 ? { error } : {})}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label="Remove guardrail"
            onClick={() => onChange(value.filter((_, item) => item !== index))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange(addRail(value))}>
          <Plus aria-hidden="true" /> Add guardrail
        </Button>
      </div>
    </div>
  );
}

function addRail(rails: readonly GuardrailDraft[]): GuardrailDraft[] {
  const used = new Set(rails.map((rail) => rail.id));
  const id = GUARDRAIL_IDS.find((candidate) => !used.has(candidate)) ?? GUARDRAIL_IDS[0];
  return [...rails, { id, options: "" }];
}

function updateRail(
  rails: readonly GuardrailDraft[],
  index: number,
  patch: Partial<GuardrailDraft>,
): GuardrailDraft[] {
  return rails.map((rail, item) => (item === index ? { ...rail, ...patch } : rail));
}
