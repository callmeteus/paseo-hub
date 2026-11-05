import type { AgentExecutionRecord, ProjectActivityRunRecord } from "../db/types.js";
import { launchedAgent } from "../db/mappers.js";
import {
  decodeEntitlementDenialFailureReason,
  entitlementDenialSummary,
} from "../entitlements/denial.js";
import { formatInvocationRejection } from "./invocation.js";

/**
 * JSON a run actually stored. `null` means the column was empty, not that we summarised it.
 * An empty object is empty: the run writer stores `{}` before anything has produced a result.
 */
export type StoredJson =
  | string
  | number
  | boolean
  | readonly StoredJson[]
  | { readonly [key: string]: StoredJson };

export interface RunStepDetail {
  id: string;
  stepId: string;
  ordinal: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Structured step output, when the step wrote one. */
  output: StoredJson | null;
  /** Agent execution result, when it was stored and is not the same value as `output`. */
  result: StoredJson | null;
  failureReason: string | null;
}

export interface RunDetail {
  id: string;
  triggerName: string;
  provider: string;
  source: string;
  repo: string | null;
  status: string;
  receivedAt: string;
  finishedAt: string | null;
  /**
   * How long a succeeded run took, from the moment the run was recorded until it finished.
   * Absent for every other status, and absent when the clock would make it negative.
   */
  duration: string | null;
  failureReason: string | null;
  prompt: string | null;
  agent: { provider: string; model: string | null } | null;
  /** Step outputs and agent results that were actually stored. */
  results: readonly { stepId: string; value: StoredJson }[];
  /** Run-level output context, when it holds something other than `{}`. */
  outputContext: StoredJson | null;
  steps: readonly RunStepDetail[];
}

/**
 * The detail Home and Activity both open. Every field is a column the run already has: a missing
 * output stays missing, and a run with no steps does not grow a placeholder list.
 */
export function presentRunDetail(
  activity: ProjectActivityRunRecord,
  executions: readonly (AgentExecutionRecord | undefined)[],
  triggerName: string,
): RunDetail {
  const { run, receipt } = activity;
  const steps = activity.steps.map((step, index) => {
    const output = storedJson(step.output);
    const executionResult = storedJson(executions[index]?.result);
    const result =
      executionResult !== null && !sameJson(output, executionResult) ? executionResult : null;
    return {
      id: step.id,
      stepId: step.stepId,
      ordinal: step.ordinal,
      status: step.status,
      startedAt: step.startedAt?.toISOString() ?? null,
      completedAt: step.completedAt?.toISOString() ?? null,
      output,
      result,
      failureReason: displayFailureReason(step.failureReason),
    };
  });
  const results: { stepId: string; value: StoredJson }[] = [];
  for (const step of steps) {
    if (step.output !== null) results.push({ stepId: step.stepId, value: step.output });
    if (step.result !== null) results.push({ stepId: step.stepId, value: step.result });
  }
  const finishedAt = run.completedAt?.toISOString() ?? null;
  const durationMs = run.status === "succeeded" ? elapsed(run.createdAt, run.completedAt) : null;
  const prompt = run.prompt.trim();
  return {
    id: run.id,
    triggerName,
    provider: receipt.provider,
    source: receipt.source,
    repo: receipt.repo,
    status: run.status,
    receivedAt: receipt.receivedAt.toISOString(),
    finishedAt,
    duration: durationMs === null ? null : formatRunDuration(durationMs),
    failureReason:
      run.outcome === "rejected"
        ? formatInvocationRejection(run.rejection)
        : displayFailureReason(run.failureReason),
    prompt: prompt.length === 0 ? null : prompt,
    agent: firstAgent(executions),
    results,
    outputContext: storedJson(run.outputContext),
    steps,
  };
}

/** A succeeded run's length, in the words the detail page prints. */
export function formatRunDuration(durationMs: number): string {
  if (durationMs < 1000) return `${String(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(minutes)}m`;
  }
  if (minutes > 0) {
    return seconds === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(seconds)}s`;
  }
  return `${String(seconds)}s`;
}

function elapsed(startedAt: Date, finishedAt: Date | null): number | null {
  if (finishedAt === null) return null;
  const duration = finishedAt.getTime() - startedAt.getTime();
  return duration >= 0 ? duration : null;
}

function firstAgent(executions: readonly (AgentExecutionRecord | undefined)[]): RunDetail["agent"] {
  for (const execution of executions) {
    const agent = launchedAgent(execution?.launchIntent?.agent);
    if (agent !== null) return agent;
  }
  return null;
}

/**
 * An entitlement denial is stored as JSON in the same text column as `agent_interrupted`.
 * The sentence is the denial itself; every other reason is already the message to show.
 */
function displayFailureReason(reason: string | null): string | null {
  if (reason === null || reason.trim() === "") return null;
  const denial = decodeEntitlementDenialFailureReason(reason);
  return denial === undefined ? reason : entitlementDenialSummary(denial);
}

function storedJson(value: unknown): StoredJson | null {
  if (typeof value === "string") return value.length === 0 ? null : value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const items = value.flatMap((entry) => {
      const stored = storedJson(entry);
      return stored === null ? [] : [stored];
    });
    return items.length === 0 ? null : items;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).flatMap(([key, child]) => {
      const stored = storedJson(child);
      return stored === null ? [] : [[key, stored] as const];
    });
    return entries.length === 0 ? null : Object.fromEntries(entries);
  }
  return null;
}

function sameJson(left: StoredJson | null, right: StoredJson | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
