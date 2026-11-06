import type { AllowedOutput } from "../execution-capabilities/outputs.js";
import type { TriggerAgentConfig } from "../triggers/index.js";
import type { WorktreeTarget } from "../config/index.js";
import type { JsonValue } from "../config/compiler.js";
import type { CompiledGitHubAuthority } from "../config/github-authority.js";
import type { Guardrail } from "../workflows/guardrails.js";

export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;

export interface DaemonEnvironmentTarget {
  kind: "daemon";
  daemonId: string;
  authoredSlug: string;
  cwd: string;
  env?: Record<string, string>;
  worktree?: WorktreeTarget;
}

/** One file the run's catalog offered to `load_instruction`. */
export interface LaunchInstruction {
  /** Path relative to `root`, as shown in the prompt catalog. */
  path: string;
  /** Catalog root from the automation YAML. */
  root: string;
}

export interface LaunchMachineIntent {
  continuation?: { key: string | null; compatibility: unknown };
  kind: "launch_machine";
  organizationId: string;
  projectId: string;
  triggerRunId: string;
  workflowStepRunId?: string;
  /** The trigger's name as the user wrote it; never the internal name of one of its events. */
  triggerName: string;
  environmentName: string;
  environment: DaemonEnvironmentTarget;
  env?: Readonly<Record<string, string>>;
  github?: CompiledGitHubAuthority;
  /** Authored workspace title, already rendered; absent means Hub's default workspace title. */
  title?: string;
  prompt: string;
  /** Files `load_instruction` may read for this run. Absent when the prompt has no catalog. */
  instructions?: readonly LaunchInstruction[];
  agent: TriggerAgentConfig;
  allowOutputs: readonly AllowedOutput[];
  timeoutMs?: number;
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  autoArchive: boolean;
  background: boolean;
  triggerContext: unknown;
  outputContext: unknown;
  outputSchema?: JsonValue;
  configurationRevisionId: string;
  deadlineAt?: Date;
  hubConfig: unknown;
  /** Rails copied from the run. Absent means this launch has no extra restriction. */
  guardrails?: readonly Guardrail[] | undefined;
}

export function buildLaunchMachineIntent(input: {
  organizationId: string;
  projectId: string;
  triggerRunId: string;
  configurationRevisionId: string;
  triggerName: string;
  environmentName: string;
  environment: DaemonEnvironmentTarget;
  env?: Readonly<Record<string, string>>;
  github?: CompiledGitHubAuthority;
  title?: string;
  prompt: string;
  instructions?: readonly LaunchInstruction[];
  agent: TriggerAgentConfig;
  allowOutputs: readonly AllowedOutput[];
  timeoutMs?: number;
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  autoArchive: boolean;
  background: boolean;
  triggerContext: unknown;
  outputContext: unknown;
  hubConfig: unknown;
  guardrails?: readonly Guardrail[] | undefined;
}): LaunchMachineIntent {
  return {
    kind: "launch_machine",
    organizationId: input.organizationId,
    projectId: input.projectId,
    triggerRunId: input.triggerRunId,
    triggerName: input.triggerName,
    environmentName: input.environmentName,
    environment: input.environment,
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.github === undefined ? {} : { github: input.github }),
    ...(input.title === undefined ? {} : { title: input.title }),
    prompt: input.prompt,
    ...(input.instructions === undefined || input.instructions.length === 0
      ? {}
      : { instructions: input.instructions }),
    agent: input.agent,
    allowOutputs: input.allowOutputs,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: input.startupTimeoutMs }),
    ...(input.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: input.idleTimeoutMs }),
    autoArchive: input.autoArchive,
    background: input.background,
    triggerContext: input.triggerContext,
    outputContext: input.outputContext,
    configurationRevisionId: input.configurationRevisionId,
    hubConfig: input.hubConfig,
    ...(input.guardrails === undefined ? {} : { guardrails: input.guardrails }),
  };
}
