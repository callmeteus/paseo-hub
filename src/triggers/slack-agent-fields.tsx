/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- each prompt row binds its own title and message */
import { Plus, Trash2 } from "lucide-react";

import { FormField } from "../components/app/form-field.js";
import { SegmentedControl } from "../components/app/segmented-control.js";
import { Button } from "../components/ui/button.js";
import { type SlackAgentDraft, type SlackAgentPromptDraft } from "./slack/agent-block.js";

/**
 * `slack_agent` on one agent reaction.
 *
 * Off leaves the block out of the YAML. On writes the display, the titles, and the prompts.
 * Feedback lets the agent send its own choice buttons.
 */
export function SlackAgentFields({
  idPrefix,
  value,
  error,
  onChange,
}: {
  idPrefix: string;
  value: SlackAgentDraft;
  error?: string;
  onChange: (value: SlackAgentDraft) => void;
}) {
  const set = (patch: Partial<SlackAgentDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-4">
      <SegmentedControl
        label="Show work in Slack"
        description="Show work in Slack"
        value={value.enabled ? "on" : "off"}
        options={[
          { value: "off", label: "Off" },
          { value: "on", label: "On" },
        ]}
        onChange={(next) => set({ enabled: next === "on" })}
      />
      {value.enabled ? (
        <>
          <SegmentedControl
            label="Display"
            description="Display"
            value={value.display}
            options={[
              { value: "plan", label: "Plan" },
              { value: "timeline", label: "Timeline" },
            ]}
            onChange={(display) => set({ display: display === "timeline" ? "timeline" : "plan" })}
          />
          <FormField
            id={`${idPrefix}-slack-session-title`}
            label="Session title"
            description="Optional. Set once, when the Slack session is created."
            kind="text"
            name={`${idPrefix}-slack-session-title`}
            value={value.sessionTitle}
            onChange={(sessionTitle) => set({ sessionTitle })}
            {...(error === undefined ? {} : { error })}
          />
          {value.display === "plan" ? (
            <FormField
              id={`${idPrefix}-slack-plan-title`}
              label="Plan title"
              description="Optional heading of the plan list."
              kind="text"
              name={`${idPrefix}-slack-plan-title`}
              value={value.planTitle}
              onChange={(planTitle) => set({ planTitle })}
            />
          ) : null}
          <div className="grid gap-3">
            <FormField
              id={`${idPrefix}-slack-prompts-title`}
              label="List title"
              description="Optional title above the suggested prompts. Leave the rows empty to omit them."
              kind="text"
              name={`${idPrefix}-slack-prompts-title`}
              value={value.promptsTitle}
              onChange={(promptsTitle) => set({ promptsTitle })}
            />
            {value.prompts.map((item, index) => (
              <div key={item.id} className="flex items-start gap-2">
                <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2">
                  <FormField
                    id={`${idPrefix}-slack-prompt-title-${String(index)}`}
                    label="Title"
                    kind="text"
                    name={`${idPrefix}-slack-prompt-title-${String(index)}`}
                    value={item.title}
                    onChange={(title) =>
                      set({ prompts: updatePrompt(value.prompts, index, { title }) })
                    }
                  />
                  <FormField
                    id={`${idPrefix}-slack-prompt-message-${String(index)}`}
                    label="Message"
                    kind="text"
                    name={`${idPrefix}-slack-prompt-message-${String(index)}`}
                    value={item.message}
                    onChange={(message) =>
                      set({ prompts: updatePrompt(value.prompts, index, { message }) })
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label="Remove suggested prompt"
                  onClick={() =>
                    set({ prompts: value.prompts.filter((_, itemIndex) => itemIndex !== index) })
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            ))}
            {value.prompts.length >= 4 ? null : (
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                onClick={() =>
                  set({
                    prompts: [...value.prompts, { id: newPromptId(), title: "", message: "" }],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Add suggested prompt
              </Button>
            )}
          </div>
          <SegmentedControl
            label="Feedback buttons"
            description="Lets the agent put its own choices on the finished card. A click continues this thread."
            value={value.feedback ? "on" : "off"}
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
            onChange={(next) => set({ feedback: next === "on" })}
          />
        </>
      ) : null}
    </div>
  );
}

function newPromptId(): string {
  return `prompt-${crypto.randomUUID()}`;
}

function updatePrompt(
  prompts: readonly SlackAgentPromptDraft[],
  index: number,
  patch: Partial<SlackAgentPromptDraft>,
): SlackAgentPromptDraft[] {
  return prompts.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item));
}
