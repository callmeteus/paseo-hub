/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop -- the mode list is this field's options, and each input writes its own key */
import { Combobox, type ComboboxOption } from "../components/app/combobox.js";
import { FormField } from "../components/app/form-field.js";
import type { WorktreeDraft } from "./configuration/form-drafts.js";

const WORKTREE_OPTIONS = [
  { value: "", label: "No worktree", detail: "Run in the working directory." },
  { value: "branch-off", label: "New branch", detail: "Create a branch for this run." },
  {
    value: "checkout-branch",
    label: "Existing branch",
    detail: "Check out a branch that already exists.",
  },
  { value: "checkout-pr", label: "Pull request", detail: "Check out a pull request." },
] as const satisfies readonly ComboboxOption[];

/**
 * `run.target.worktree`. Empty means the run stays on the working directory.
 * The other modes are the three checkouts the daemon already accepts.
 */
export function WorktreeFields({
  value,
  error,
  onChange,
}: {
  value: WorktreeDraft;
  error?: string;
  onChange: (value: WorktreeDraft) => void;
}) {
  const setMode = (mode: WorktreeDraft["mode"]) => onChange({ ...value, mode });
  return (
    <>
      <FormField
        id="trigger-worktree"
        label="Worktree"
        description="Optional. The daemon checks out this worktree for the run and removes it when the run archives."
        {...(error !== undefined && value.mode === "" ? { error } : {})}
      >
        {(control) => (
          <Combobox
            {...control}
            value={value.mode}
            options={WORKTREE_OPTIONS}
            placeholder="No worktree"
            empty="No worktree modes found."
            onChange={(option) => setMode(worktreeMode(option.value))}
          />
        )}
      </FormField>
      {value.mode === "branch-off" ? (
        <>
          <FormField
            id="trigger-worktree-branch"
            label="New branch"
            description="Branch the daemon creates for the run."
            kind="text"
            name="worktreeNewBranch"
            value={value.newBranch}
            onChange={(newBranch) => onChange({ ...value, newBranch })}
            required
            {...(error === undefined ? {} : { error })}
          />
          <FormField
            id="trigger-worktree-base"
            label="Base branch"
            description="Leave empty to start from the current checkout."
            kind="text"
            name="worktreeBase"
            value={value.base}
            onChange={(base) => onChange({ ...value, base })}
          />
        </>
      ) : null}
      {value.mode === "checkout-branch" ? (
        <FormField
          id="trigger-worktree-existing"
          label="Branch"
          description="Existing branch to check out."
          kind="text"
          name="worktreeBranch"
          value={value.branch}
          onChange={(branch) => onChange({ ...value, branch })}
          required
          {...(error === undefined ? {} : { error })}
        />
      ) : null}
      {value.mode === "checkout-pr" ? (
        <FormField
          id="trigger-worktree-pr"
          label="Pull request"
          description="Pull request number to check out."
          kind="number"
          name="worktreePr"
          value={value.prNumber}
          onChange={(prNumber) => onChange({ ...value, prNumber })}
          required
          min={1}
          step={1}
          {...(error === undefined ? {} : { error })}
        />
      ) : null}
    </>
  );
}

function worktreeMode(value: string): WorktreeDraft["mode"] {
  if (value === "branch-off" || value === "checkout-branch" || value === "checkout-pr")
    return value;
  return "";
}
