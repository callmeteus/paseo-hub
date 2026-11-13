/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop -- each reaction binds its own fields */
import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { Button } from "../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { Combobox, type ComboboxOption } from "../components/app/combobox.js";
import { FormField } from "../components/app/form-field.js";
import { SegmentedControl } from "../components/app/segmented-control.js";
import type { TriggerFieldErrors } from "./configuration/editor.js";
import { InstructionsEditor } from "./instructions-editor.js";
import { ReactionFlow } from "./configuration/reaction-form.js";
import { SlackAgentFields } from "./slack-agent-fields.js";
import { trueBranch } from "./configuration/schema.js";
import { supportsUnattendedRuns } from "./configuration/unattended.js";
import { selectedProviderModel } from "./provider-catalog.js";

/**
 * The ordered reactions of one trigger: agents, waits, and conditions.
 *
 * @param flow - Reactions in run order
 * @param errors - Field errors keyed by reaction
 * @param entries - Models the selected daemon can run
 * @param loading - Whether that catalog is still loading
 * @param githubConnectionOptions - GitHub connections the agent may use
 * @param showSlackAgent - Whether every selected event is a Slack message or mention
 * @param onChange - Replaces the flow
 * @returns The reaction list
 */
export function ReactionFlowEditor({
  flow,
  errors,
  entries,
  loading,
  githubConnectionOptions,
  showSlackAgent,
  onChange,
}: {
  flow: readonly ReactionFlow.Reaction[];
  errors: TriggerFieldErrors;
  entries: HubProviderSnapshotEntry[] | undefined;
  loading: boolean;
  githubConnectionOptions: readonly ComboboxOption[];
  showSlackAgent: boolean;
  onChange: (flow: ReactionFlow.Reaction[]) => void;
}) {
  return (
    <div className="grid gap-4">
      <ReactionList
        reactions={flow}
        errors={errors}
        entries={entries}
        loading={loading}
        githubConnectionOptions={githubConnectionOptions}
        showSlackAgent={showSlackAgent}
        onChange={onChange}
      />
      <AddReaction onAdd={(kind) => onChange(ReactionFlow.append(flow, kind, undefined, "root"))} />
    </div>
  );
}

function ReactionList({
  reactions,
  errors,
  entries,
  loading,
  githubConnectionOptions,
  showSlackAgent,
  onChange,
}: {
  reactions: readonly ReactionFlow.Reaction[];
  errors: TriggerFieldErrors;
  entries: HubProviderSnapshotEntry[] | undefined;
  loading: boolean;
  githubConnectionOptions: readonly ComboboxOption[];
  showSlackAgent: boolean;
  onChange: (reactions: ReactionFlow.Reaction[]) => void;
}) {
  return (
    <div className="grid gap-3">
      {reactions.map((reaction, index) => (
        <section key={reaction.id} className="grid gap-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{reactionLabel(reaction.type)}</p>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Move earlier"
                disabled={index === 0}
                onClick={() => onChange(ReactionFlow.move(reactions, reaction.id, -1))}
              >
                <ChevronUp aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Move later"
                disabled={index === reactions.length - 1}
                onClick={() => onChange(ReactionFlow.move(reactions, reaction.id, 1))}
              >
                <ChevronDown aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove reaction"
                onClick={() => onChange(ReactionFlow.remove(reactions, reaction.id))}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          </div>
          <FormField
            id={`reaction-${reaction.id}-name`}
            label="Name"
            description="Used in later conditions, for example steps.wait."
            kind="text"
            name={`reaction-${reaction.id}-name`}
            value={reaction.id}
            onChange={(id) => onChange(rename(reactions, reaction.id, id))}
            {...flowError(errors, reaction.id, "id")}
          />
          <ReactionBody
            reaction={reaction}
            reactions={reactions}
            errors={errors}
            entries={entries}
            loading={loading}
            githubConnectionOptions={githubConnectionOptions}
            showSlackAgent={showSlackAgent}
            onChange={onChange}
          />
        </section>
      ))}
    </div>
  );
}

function ReactionBody({
  reaction,
  reactions,
  errors,
  entries,
  loading,
  githubConnectionOptions,
  showSlackAgent,
  onChange,
}: {
  reaction: ReactionFlow.Reaction;
  reactions: readonly ReactionFlow.Reaction[];
  errors: TriggerFieldErrors;
  entries: HubProviderSnapshotEntry[] | undefined;
  loading: boolean;
  githubConnectionOptions: readonly ComboboxOption[];
  showSlackAgent: boolean;
  onChange: (reactions: ReactionFlow.Reaction[]) => void;
}) {
  if (reaction.type === "wait") {
    return (
      <FormField
        id={`reaction-${reaction.id}-for`}
        label="Wait"
        description="How long to wait before the next reaction, for example 5m."
        kind="text"
        name={`reaction-${reaction.id}-for`}
        value={reaction.duration}
        onChange={(duration) => onChange(ReactionFlow.update(reactions, reaction.id, { duration }))}
        required
        {...flowError(errors, reaction.id, "duration")}
      />
    );
  }
  if (reaction.type === "env" || reaction.type === "http" || reaction.type === "notice") {
    return (
      <PlainReactionFields
        reaction={reaction}
        errors={errors}
        onChange={(patch) => onChange(ReactionFlow.update(reactions, reaction.id, patch))}
      />
    );
  }
  if (reaction.type === "agent") {
    return (
      <AgentReactionFields
        reaction={reaction}
        errors={errors}
        entries={entries}
        loading={loading}
        githubConnectionOptions={githubConnectionOptions}
        showSlackAgent={showSlackAgent}
        onChange={(patch) => onChange(ReactionFlow.update(reactions, reaction.id, patch))}
      />
    );
  }
  return (
    <ConditionFields
      reaction={reaction}
      reactions={reactions}
      errors={errors}
      entries={entries}
      loading={loading}
      githubConnectionOptions={githubConnectionOptions}
      showSlackAgent={showSlackAgent}
      onChange={onChange}
    />
  );
}

function PlainReactionFields({
  reaction,
  errors,
  onChange,
}: {
  reaction: ReactionFlow.Env | ReactionFlow.Http | ReactionFlow.Notice;
  errors: TriggerFieldErrors;
  onChange: (
    patch: Partial<ReactionFlow.Env> | Partial<ReactionFlow.Http> | Partial<ReactionFlow.Notice>,
  ) => void;
}) {
  if (reaction.type === "env") {
    return (
      <FormField
        id={`reaction-${reaction.id}-files`}
        label="Env files"
        description="One dotenv path per line, for example ~/.lm.credentials."
        kind="multiline"
        name={`reaction-${reaction.id}-files`}
        value={reaction.files}
        onChange={(files) => onChange({ files })}
        required
        {...flowError(errors, reaction.id, "files")}
      />
    );
  }
  if (reaction.type === "notice") {
    return (
      <FormField
        id={`reaction-${reaction.id}-text`}
        label="Notice"
        description="Stored on the run. It does not send a message."
        kind="multiline"
        name={`reaction-${reaction.id}-text`}
        value={reaction.text}
        onChange={(text) => onChange({ text })}
        required
        {...flowError(errors, reaction.id, "text")}
      />
    );
  }
  return (
    <div className="grid gap-4">
      <FormField id={`reaction-${reaction.id}-method`} label="Method">
        {() => (
          <SegmentedControl
            label="Method"
            value={reaction.method}
            options={[
              { value: "GET", label: "GET" },
              { value: "POST", label: "POST" },
            ]}
            onChange={(method) => {
              if (method === "GET" || method === "POST") onChange({ method });
            }}
          />
        )}
      </FormField>
      <FormField
        id={`reaction-${reaction.id}-url`}
        label="URL"
        description="HTTPS only. POST sends the assign path."
        kind="text"
        name={`reaction-${reaction.id}-url`}
        value={reaction.url}
        onChange={(url) => onChange({ url })}
        required
        {...flowError(errors, reaction.id, "url")}
      />
      <FormField
        id={`reaction-${reaction.id}-headers`}
        label="Headers"
        description="One header per line, Name: value."
        kind="multiline"
        name={`reaction-${reaction.id}-headers`}
        value={reaction.headers}
        onChange={(headers) => onChange({ headers })}
        required
        {...flowError(errors, reaction.id, "headers")}
      />
    </div>
  );
}

function ConditionFields({
  reaction,
  reactions,
  errors,
  entries,
  loading,
  githubConnectionOptions,
  showSlackAgent,
  onChange,
}: {
  reaction: ReactionFlow.Condition;
  reactions: readonly ReactionFlow.Reaction[];
  errors: TriggerFieldErrors;
  entries: HubProviderSnapshotEntry[] | undefined;
  loading: boolean;
  githubConnectionOptions: readonly ComboboxOption[];
  showSlackAgent: boolean;
  onChange: (reactions: ReactionFlow.Reaction[]) => void;
}) {
  const replace = (patch: Partial<ReactionFlow.Condition>) =>
    onChange(
      reactions.map((item) =>
        item.id === reaction.id && item.type === "if"
          ? { ...item, ...patch, id: item.id, type: item.type }
          : item,
      ),
    );
  return (
    <div className="grid gap-3">
      <FormField
        id={`reaction-${reaction.id}-condition`}
        label="Condition"
        description="The true branch runs when this expression is true. The false branch runs otherwise."
        kind="text"
        name={`reaction-${reaction.id}-condition`}
        value={reaction.condition}
        onChange={(condition) => replace({ condition })}
        required
        {...flowError(errors, reaction.id, "condition")}
      />
      <Branch
        title="True"
        reactions={reaction.then}
        errors={errors}
        entries={entries}
        loading={loading}
        githubConnectionOptions={githubConnectionOptions}
        showSlackAgent={showSlackAgent}
        onChange={(then) => replace(trueBranch(then))}
        onAdd={(kind) =>
          replace(trueBranch(ReactionFlow.append(reaction.then, kind, undefined, "root")))
        }
      />
      <Branch
        title="False"
        reactions={reaction.else}
        errors={errors}
        entries={entries}
        loading={loading}
        githubConnectionOptions={githubConnectionOptions}
        showSlackAgent={showSlackAgent}
        onChange={(elseReactions) => replace({ else: elseReactions })}
        onAdd={(kind) =>
          replace({ else: ReactionFlow.append(reaction.else, kind, undefined, "root") })
        }
      />
    </div>
  );
}

function Branch({
  title,
  reactions,
  errors,
  entries,
  loading,
  githubConnectionOptions,
  showSlackAgent,
  onChange,
  onAdd,
}: {
  title: string;
  reactions: readonly ReactionFlow.Reaction[];
  errors: TriggerFieldErrors;
  entries: HubProviderSnapshotEntry[] | undefined;
  loading: boolean;
  githubConnectionOptions: readonly ComboboxOption[];
  showSlackAgent: boolean;
  onChange: (reactions: ReactionFlow.Reaction[]) => void;
  onAdd: (kind: ReactionFlow.Kind) => void;
}) {
  return (
    <div className="grid gap-3 border-l pl-3">
      <p className="text-sm font-medium">{title}</p>
      {reactions.length === 0 ? null : (
        <ReactionList
          reactions={reactions}
          errors={errors}
          entries={entries}
          loading={loading}
          githubConnectionOptions={githubConnectionOptions}
          showSlackAgent={showSlackAgent}
          onChange={onChange}
        />
      )}
      <AddReaction onAdd={onAdd} />
    </div>
  );
}

function AgentReactionFields({
  reaction,
  errors,
  entries,
  loading,
  githubConnectionOptions,
  showSlackAgent,
  onChange,
}: {
  reaction: ReactionFlow.Agent;
  errors: TriggerFieldErrors;
  entries: HubProviderSnapshotEntry[] | undefined;
  loading: boolean;
  githubConnectionOptions: readonly ComboboxOption[];
  showSlackAgent: boolean;
  onChange: (patch: Partial<ReactionFlow.Agent>) => void;
}) {
  const agentOptions = catalogOptions(entries);
  const selected = selectedProviderModel(entries, reaction.agent);
  const modeOptions = (selected.entry?.modes ?? []).map((mode) => ({
    value: mode.id,
    label: mode.label,
  }));
  const thinkingOptions = (selected.model?.thinkingOptions ?? []).map((option) => ({
    value: option.id,
    label: option.label,
  }));
  const githubEnabled = reaction.githubConnection !== "";
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id={`reaction-${reaction.id}-agent`}
          label="Agent"
          required
          {...flowError(errors, reaction.id, "agent")}
        >
          {(control) => (
            <Combobox
              {...control}
              required
              loading={loading}
              value={reaction.agent}
              options={agentOptions}
              placeholder="Select a model"
              searchPlaceholder="Search models…"
              empty="No models found."
              onChange={(option) =>
                onChange({
                  agent: option.value,
                  mode: "",
                  thinkingOptionId: "",
                  cursorFast: option.value.startsWith("cursor")
                    ? reaction.cursorFast || "false"
                    : "",
                })
              }
            />
          )}
        </FormField>
        <FormField
          id={`reaction-${reaction.id}-mode`}
          label="Execution mode"
          required
          {...flowError(errors, reaction.id, "mode")}
        >
          {(control) => (
            <Combobox
              {...control}
              required
              value={reaction.mode}
              options={modeOptions}
              placeholder="Select a mode"
              empty="No modes found."
              onChange={(option) => onChange({ mode: option.value })}
            />
          )}
        </FormField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id={`reaction-${reaction.id}-max-runtime`}
          label="Maximum runtime"
          description="Hard deadline for this agent, for example 2h."
          kind="text"
          name={`reaction-${reaction.id}-max-runtime`}
          value={reaction.maxRuntime}
          onChange={(maxRuntime) => onChange({ maxRuntime })}
          required
          {...flowError(errors, reaction.id, "maxRuntime")}
        />
        <FormField
          id={`reaction-${reaction.id}-idle-timeout`}
          label="Idle timeout"
          description="Stop this agent when it goes quiet, for example 10m."
          kind="text"
          name={`reaction-${reaction.id}-idle-timeout`}
          value={reaction.idleTimeout}
          onChange={(idleTimeout) => onChange({ idleTimeout })}
          required
          {...flowError(errors, reaction.id, "idleTimeout")}
        />
      </div>
      {reaction.agent.startsWith("cursor") ? (
        <FormField id={`reaction-${reaction.id}-fast`} label="Fast">
          {() => (
            <SegmentedControl
              label="Fast"
              value={reaction.cursorFast === "true" ? "true" : "false"}
              options={[
                { value: "false", label: "Off" },
                { value: "true", label: "On" },
              ]}
              onChange={(cursorFast) => onChange({ cursorFast })}
            />
          )}
        </FormField>
      ) : null}
      {thinkingOptions.length === 0 ? null : (
        <FormField id={`reaction-${reaction.id}-thinking`} label="Thinking" required>
          {(control) => (
            <Combobox
              {...control}
              required
              value={reaction.thinkingOptionId}
              options={thinkingOptions}
              placeholder="Select a thinking option"
              empty="No thinking options found."
              onChange={(option) => onChange({ thinkingOptionId: option.value })}
            />
          )}
        </FormField>
      )}
      <InstructionsEditor
        id={`reaction-${reaction.id}-prompt`}
        value={reaction.prompt}
        onChange={(prompt) => onChange({ prompt })}
        {...flowError(errors, reaction.id, "prompt")}
      />
      {showSlackAgent ? (
        <SlackAgentFields
          idPrefix={`reaction-${reaction.id}`}
          value={reaction.slackAgent}
          onChange={(slackAgent) => onChange({ slackAgent })}
          {...flowError(errors, reaction.id, "slackAgent")}
        />
      ) : null}
      <SegmentedControl
        label="Agent continuity"
        description="Agent continuity"
        value={reaction.continuationMode}
        onChange={(continuationMode) => onChange({ continuationMode })}
        options={[
          { value: "conversation", label: "Same conversation" },
          { value: "key", label: "Custom key" },
          { value: "new", label: "New agent" },
        ]}
      />
      {reaction.continuationMode === "key" ? (
        <FormField
          id={`reaction-${reaction.id}-key`}
          label="Continuation key"
          kind="text"
          name={`reaction-${reaction.id}-key`}
          value={reaction.continuationKey}
          onChange={(continuationKey) => onChange({ continuationKey })}
          required
          {...flowError(errors, reaction.id, "continuationKey")}
        />
      ) : null}
      <FormField id={`reaction-${reaction.id}-github`} label="GitHub connection">
        {(control) => (
          <Combobox
            {...control}
            value={reaction.githubConnection}
            options={githubConnectionOptions}
            placeholder="Select a GitHub connection"
            empty="No GitHub connections found."
            onChange={(option) => onChange({ githubConnection: option.value })}
          />
        )}
      </FormField>
      {githubEnabled ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id={`reaction-${reaction.id}-repos`}
            label="GitHub repositories"
            kind="text"
            name={`reaction-${reaction.id}-repos`}
            value={reaction.githubRepositories}
            onChange={(githubRepositories) => onChange({ githubRepositories })}
            required
          />
          <FormField
            id={`reaction-${reaction.id}-duration`}
            label="GitHub token lifetime"
            kind="text"
            name={`reaction-${reaction.id}-duration`}
            value={reaction.githubDuration}
            onChange={(githubDuration) => onChange({ githubDuration })}
            required
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Adds a reaction after the ones already in this list.
 *
 * @param onAdd - Receives the kind the reader picked
 * @returns The menu
 */
export function AddReaction({ onAdd }: { onAdd: (kind: ReactionFlow.Kind) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Plus aria-hidden="true" /> Add reaction
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onAdd("agent")}>Agent</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("wait")}>Wait</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("if")}>Condition</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("env")}>Load env files</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("http")}>HTTP request</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd("notice")}>Notice</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function reactionLabel(kind: ReactionFlow.Kind): string {
  if (kind === "wait") return "Wait";
  if (kind === "if") return "Condition";
  if (kind === "env") return "Env files";
  if (kind === "http") return "HTTP request";
  if (kind === "notice") return "Notice";
  return "Agent";
}

function flowError(errors: TriggerFieldErrors, id: string, field: string) {
  const error = errors[`flow.${id}.${field}`];
  return error === undefined ? {} : { error };
}

function rename(
  reactions: readonly ReactionFlow.Reaction[],
  id: string,
  nextId: string,
): ReactionFlow.Reaction[] {
  return reactions.map((reaction) => {
    if (reaction.id === id) return { ...reaction, id: nextId };
    if (reaction.type !== "if") return reaction;
    return {
      ...reaction,
      ...trueBranch(rename(reaction.then, id, nextId)),
      else: rename(reaction.else, id, nextId),
    };
  });
}

function catalogOptions(entries: HubProviderSnapshotEntry[] | undefined): ComboboxOption[] {
  return (entries ?? []).flatMap((entry) =>
    entry.status !== "ready" || !entry.enabled || !supportsUnattendedRuns(entry.provider)
      ? []
      : (entry.models ?? [])
          .filter((model) => model.isSelectable !== false)
          .map((model) => ({
            value: `${entry.provider}/${model.id}`,
            label: model.label,
            detail: `${entry.label ?? entry.provider} · ${entry.provider}/${model.id}`,
            keywords: [model.label, entry.label ?? entry.provider, model.id],
          })),
  );
}
