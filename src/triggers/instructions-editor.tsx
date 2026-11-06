/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- each instruction block binds its own text */
import { Plus, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { FormField } from "../components/app/form-field.js";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";
import { textInstructions, type InstructionDraft } from "./configuration/form-drafts.js";

const MERGE_TAGS = ["${{ paseo.prompt }}", "${{ paseo.context }}"] as const;

/**
 * The instructions on an agent. One text block is the textarea the form already had.
 * Adding a file or a catalog, or a document that already has one, edits the same
 * ordered list of `text`, `include`, and `load` blocks.
 */
export function InstructionsEditor({
  id,
  value,
  error,
  onChange,
}: {
  id: string;
  value: readonly InstructionDraft[];
  error?: string;
  onChange: (value: InstructionDraft[]) => void;
}) {
  const [only] = value;
  const singleText = value.length === 1 && only?.kind === "text";
  if (singleText && only.kind === "text") {
    return (
      <div className="grid gap-4">
        <PromptText
          id={id}
          value={only.text}
          {...(error === undefined ? {} : { error })}
          onChange={(text) => onChange(textInstructions(text))}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(addInclude(value))}
          >
            <Plus aria-hidden="true" /> Add instruction file
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(addCatalog(value))}
          >
            <Plus aria-hidden="true" /> Add instruction catalog
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {value.map((part, index) => (
        <InstructionPart
          key={partKey(part, index)}
          id={`${id}-${String(index)}`}
          part={part}
          {...(error !== undefined && index === 0 ? { error } : {})}
          onChange={(next) => onChange(replacePart(value, index, next))}
          onRemove={() => onChange(value.filter((_, item) => item !== index))}
        />
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...value, { kind: "text", text: "" }])}
        >
          <Plus aria-hidden="true" /> Add text
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange(addInclude(value))}
        >
          <Plus aria-hidden="true" /> Add instruction file
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange(addCatalog(value))}
        >
          <Plus aria-hidden="true" /> Add instruction catalog
        </Button>
      </div>
    </div>
  );
}

function InstructionPart({
  id,
  part,
  error,
  onChange,
  onRemove,
}: {
  id: string;
  part: InstructionDraft;
  error?: string;
  onChange: (part: InstructionDraft) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="grid min-w-0 flex-1 gap-4">
        <InstructionFields
          id={id}
          part={part}
          {...(error === undefined ? {} : { error })}
          onChange={onChange}
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        aria-label="Remove instruction"
        onClick={onRemove}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

function InstructionFields({
  id,
  part,
  error,
  onChange,
}: {
  id: string;
  part: InstructionDraft;
  error?: string;
  onChange: (part: InstructionDraft) => void;
}) {
  if (part.kind === "text") {
    return (
      <PromptText
        id={id}
        value={part.text}
        {...(error === undefined ? {} : { error })}
        onChange={(text) => onChange({ kind: "text", text })}
      />
    );
  }
  if (part.kind === "include") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id={`${id}-path`}
          label="Instruction file"
          description="Path relative to the working directory, or to the root beside it."
          kind="text"
          name={`${id}-path`}
          value={part.path}
          onChange={(path) => onChange({ ...part, path })}
          required
          {...(error === undefined ? {} : { error })}
        />
        <FormField
          id={`${id}-root`}
          label="Root"
          description="Absolute path, or ~. Leave empty to use the working directory."
          kind="text"
          name={`${id}-root`}
          value={part.root}
          onChange={(root) => onChange({ ...part, root })}
        />
      </div>
    );
  }
  return (
    <FormField
      id={`${id}-root`}
      label="Instruction catalog"
      description="Directory of markdown files the agent can load. Absolute path, or ~."
      kind="text"
      name={`${id}-root`}
      value={part.root}
      onChange={(root) => onChange({ kind: "load", root })}
      required
      {...(error === undefined ? {} : { error })}
    />
  );
}

function PromptText({
  id,
  value,
  error,
  onChange,
}: {
  id: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (element === null) return;
    element.style.height = "0px";
    element.style.height = `${String(element.scrollHeight)}px`;
  }, [value]);
  const insert = (mergeTag: string) => {
    const element = textarea.current;
    if (element === null) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    onChange(`${value.slice(0, start)}${mergeTag}${value.slice(end)}`);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + mergeTag.length, start + mergeTag.length);
    });
  };
  return (
    <div className="grid gap-2">
      <FormField id={id} label="Instructions" required {...(error === undefined ? {} : { error })}>
        {(control) => (
          <Textarea
            {...control}
            ref={textarea}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            rows={8}
            spellCheck={false}
            className="min-h-48 resize-none overflow-hidden font-mono text-xs"
          />
        )}
      </FormField>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Insert merge tag:</span>
        {MERGE_TAGS.map((mergeTag) => (
          <Button
            key={mergeTag}
            type="button"
            variant="outline"
            size="xs"
            className="font-mono"
            onClick={() => insert(mergeTag)}
          >
            {mergeTag}
          </Button>
        ))}
      </div>
    </div>
  );
}

function addInclude(parts: readonly InstructionDraft[]): InstructionDraft[] {
  return [...parts, { kind: "include", path: "", root: "" }];
}

function addCatalog(parts: readonly InstructionDraft[]): InstructionDraft[] {
  return [...parts, { kind: "load", root: "" }];
}

function replacePart(
  parts: readonly InstructionDraft[],
  index: number,
  next: InstructionDraft,
): InstructionDraft[] {
  return parts.map((part, item) => (item === index ? next : part));
}

function partKey(part: InstructionDraft, index: number): string {
  return `${part.kind}-${String(index)}`;
}
