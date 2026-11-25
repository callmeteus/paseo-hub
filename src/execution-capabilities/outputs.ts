import type { JsonValue } from "../config/compiler.js";
import { compileFinishExecutionArguments } from "../workflows/json-schema.js";
import {
  enforceSlackGuardrails,
  slackGuardrailCheck,
  type Guardrail,
} from "../workflows/guardrails.js";

/** Structured fields the Hub requires before it accepts a closing reply. */
export interface ReplyContract {
  required: readonly string[];
  stateEnum: readonly string[];
}

export interface AllowedOutput {
  type: string;
  /** Absent for the event-native reply capability exposed by single-run triggers. */
  max?: number | undefined;
  required?: boolean;
  /** Per-argument numeric maxima the Hub enforces before the tool runs. */
  args_limit?: Record<string, number> | undefined;
  /** Optional closing-reply contract, configured by the trigger author. */
  contract?: ReplyContract | undefined;
}

export interface OutputToolSchemaNode {
  readonly [key: string]: JsonValue;
}

export interface OutputToolSchema extends OutputToolSchemaNode {
  readonly type: "object";
  readonly properties?: Record<string, OutputToolSchemaNode>;
  readonly required?: string[];
}

export interface OutputToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: OutputToolSchema;
}

export interface OutputExecutionInput {
  agentExecutionId: string;
  attemptId?: string;
  toolType: string;
  args: Record<string, unknown>;
  outputContext: unknown;
  /** Rails copied from the run. Absent means this send has no extra restriction. */
  guardrails?: readonly Guardrail[] | undefined;
  /** Triggering event. Slack rails read the source channel and thread from it. */
  triggerContext?: unknown;
}

/**
 * Runs one output tool.
 *
 * A read-only tool returns the text the model should read. A tool that only
 * delivers something to the provider resolves to `undefined` and the capability
 * server answers with its own acknowledgement.
 */
export type OutputExecutor = (input: OutputExecutionInput) => Promise<string | void>;

export interface OutputCapability {
  readonly type: string;
  readonly tool: OutputToolDefinition;
  readonly available?: (outputContext: unknown) => boolean;
  readonly execute: OutputExecutor;
}

export interface MaterializedOutputCapability {
  readonly declaration: AllowedOutput;
  readonly capability: OutputCapability;
}

export const finishExecutionToolName = "finish_execution" as const;
export const clearHardDeadlineToolName = "clear_hard_deadline" as const;
export const loadInstructionToolName = "load_instruction" as const;
export const readSlackMessagesToolName = "read_slack_messages" as const;
/** Closing reply with a Hub-enforced structured contract. Absent unless configured. */
export const finalReplyToolName = "final_reply" as const;
export const memorySaveToolName = "memory_save" as const;
export const memorySearchToolName = "memory_search" as const;
export const feedbackSearchToolName = "feedback_search" as const;

const clearHardDeadlineTool: OutputToolDefinition = {
  name: clearHardDeadlineToolName,
  description:
    "Removes the hard time limit on this execution and the run that owns it. The idle timeout still applies. Any execution can call this when the work will outlast the current limit.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const loadInstructionTool: OutputToolDefinition = {
  name: loadInstructionToolName,
  description:
    "Returns one instruction file from this run's catalog. Pass the path from the catalog in the prompt.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const memorySaveTool: OutputToolDefinition = {
  name: memorySaveToolName,
  description:
    "Saves a finding for this organization. Requires the fact, the Slack replies that support it, and the tool call used to verify it. This does not post to Slack.",
  inputSchema: {
    type: "object",
    properties: {
      statement: { type: "string", minLength: 1 },
      replies: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 },
      },
      tool: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          result: { type: "string", minLength: 1 },
        },
        required: ["name", "result"],
        additionalProperties: false,
      },
    },
    required: ["statement", "replies", "tool"],
    additionalProperties: false,
  },
};

const feedbackSearchTool: OutputToolDefinition = {
  name: feedbackSearchToolName,
  description:
    "Searches thumbs on this organization's agent cards. Each result is a rating, an optional comment, the channel, and the message timestamp. Findings stay in memory_search.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    additionalProperties: false,
  },
};

const memorySearchTool: OutputToolDefinition = {
  name: memorySearchToolName,
  description:
    "Searches this organization's findings. Each result includes the fact, the Slack replies, and the tool call stored with it.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    additionalProperties: false,
  },
};

function finishExecutionToolDescription(outputSchema: JsonValue | undefined): string {
  return outputSchema === undefined
    ? "Completes this execution and records its optional structured output."
    : "Completes this execution and records the configured structured output.";
}

export const replyOutputTool: OutputToolDefinition = {
  name: "reply",
  description: "Sends a reply to the conversation that triggered this execution.",
  inputSchema: {
    type: "object",
    properties: { content: { type: "string", minLength: 1 } },
    required: ["content"],
    additionalProperties: false,
  },
};

export function outputContextProvider(provider: string): (outputContext: unknown) => boolean {
  return (outputContext) =>
    typeof outputContext === "object" &&
    outputContext !== null &&
    Reflect.get(outputContext, "provider") === provider;
}

export class OutputCapabilityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputCapabilityValidationError";
  }
}

export class OutputExecutorRegistry {
  private readonly capabilities = new Map<string, OutputCapability>();

  register(capability: OutputCapability): void {
    if (capability.type.length === 0) throw new Error("output capability type is required");
    if (capability.tool.name.length === 0) {
      throw new Error(`output capability tool name is required: ${capability.type}`);
    }
    if (this.capabilities.has(capability.type)) {
      throw new Error(`output capability is already registered: ${capability.type}`);
    }
    this.capabilities.set(capability.type, capability);
  }

  validateRequiredOutputs(allowedOutputs: readonly AllowedOutput[], outputContext: unknown): void {
    const unavailable = allowedOutputs
      .filter((output) => output.required === true)
      .filter((output) => !this.isAvailable(output.type, outputContext))
      .map((output) => output.type);
    if (unavailable.length > 0) {
      throw new OutputCapabilityValidationError(
        `required output capability unavailable: ${unavailable.join(", ")}; register a Hub output tool for each type or remove required: true`,
      );
    }
  }

  materialize(
    allowedOutputs: readonly AllowedOutput[],
    outputContext: unknown,
  ): readonly MaterializedOutputCapability[] {
    this.validateRequiredOutputs(allowedOutputs, outputContext);
    const materialized = this.availableOutputs(allowedOutputs, outputContext);
    const byToolName = new Map<string, MaterializedOutputCapability>();
    for (const output of materialized) {
      const previous = byToolName.get(output.capability.tool.name);
      if (previous !== undefined && previous.declaration.type !== output.declaration.type) {
        throw new OutputCapabilityValidationError(
          `output capabilities ${previous.declaration.type} and ${output.declaration.type} both expose Hub tool ${output.capability.tool.name}; register unique tool names`,
        );
      }
      byToolName.set(output.capability.tool.name, output);
    }
    return materialized;
  }

  private availableOutputs(
    allowedOutputs: readonly AllowedOutput[],
    outputContext: unknown,
  ): readonly MaterializedOutputCapability[] {
    return allowedOutputs.flatMap((declaration) => {
      const capability = this.capabilities.get(declaration.type);
      return capability !== undefined && this.isAvailable(declaration.type, outputContext)
        ? [{ declaration, capability }]
        : [];
    });
  }

  private isAvailable(type: string, outputContext: unknown): boolean {
    const capability = this.capabilities.get(type);
    return capability !== undefined && (capability.available?.(outputContext) ?? true);
  }

  /**
   * Runs one output tool.
   *
   * @param input - Execution, arguments, and contexts for this call
   * @returns What a read-only tool read, or undefined when it only delivered
   */
  async execute(input: OutputExecutionInput): Promise<string | void> {
    const capability = this.capabilities.get(input.toolType);
    if (capability === undefined) {
      throw new Error(`no output executor registered for ${input.toolType}`);
    }
    // The model can describe another channel in its prompt. This is the check
    // that actually stops the Slack post.
    enforceSlackGuardrails(
      slackGuardrailCheck({
        guardrails: input.guardrails,
        toolType: input.toolType,
        triggerContext: input.triggerContext,
        outputContext: input.outputContext,
      }),
    );
    return capability.execute(input);
  }
}

/**
 * The separate tool for a closing reply. Keeping it distinct from `reply` lets
 * intermediate plan and finding replies pass unchanged while the Hub validates
 * the structured fields of the final one.
 *
 * @param contract - Fields and states the trigger author requires
 * @returns The tool definition
 */
export function finalReplyTool(contract: ReplyContract): OutputToolDefinition {
  return {
    name: finalReplyToolName,
    description:
      "Sends the closing reply. Structured fields are required by the trigger and the Hub appends a state line.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1 },
        ...Object.fromEntries(
          contract.required.map((field) => [
            field,
            field === "pr_links"
              ? { type: "array", items: { type: "string", minLength: 1 } }
              : { type: "string", minLength: 1 },
          ]),
        ),
      },
      required: ["content", ...contract.required.filter((field) => field !== "content")],
      additionalProperties: false,
    },
  };
}

export function executionToolDefinitions(
  outputSchema: JsonValue | undefined,
  materializedOutputs: readonly MaterializedOutputCapability[],
  loadInstructions = false,
): readonly OutputToolDefinition[] {
  const telegramReply = materializedOutputs.find(
    (output) => output.capability.tool.name === "telegram_reply",
  );
  const replyContract = materializedOutputs.find(
    (output) => output.capability.tool.name === "reply",
  )?.declaration.contract;
  return [
    ...(replyContract === undefined ? [] : [finalReplyTool(replyContract)]),
    {
      name: finishExecutionToolName,
      description: finishExecutionToolDescription(outputSchema),
      inputSchema: toolSchema(compileFinishExecutionArguments(outputSchema).schema),
    },
    clearHardDeadlineTool,
    memorySaveTool,
    memorySearchTool,
    feedbackSearchTool,
    ...(loadInstructions ? [loadInstructionTool] : []),
    ...materializedOutputs.map(({ declaration, capability }) => ({
      name: capability.tool.name,
      description:
        declaration.max === undefined
          ? capability.tool.description
          : `${capability.tool.description} (up to ${String(declaration.max)} times).`,
      inputSchema: capability.tool.inputSchema,
    })),
    // Continuations that started before Telegram got its own tool name still
    // call `reply`. Keep that name working for them alongside `telegram_reply`.
    ...(telegramReply === undefined
      ? []
      : [
          {
            name: "reply",
            description: "Alias of telegram_reply for older continuations.",
            inputSchema: telegramReply.capability.tool.inputSchema,
          },
        ]),
  ];
}

function toolSchema(value: JsonValue): OutputToolSchema {
  if (!isToolSchema(value)) throw new Error("JSON Schema tool arguments must be an object");
  return value;
}

function isToolSchema(value: JsonValue): value is OutputToolSchema {
  if (!isSchemaNode(value) || value["type"] !== "object") return false;
  const properties = value["properties"];
  const required = value["required"];
  return (
    (properties === undefined ||
      (isRecord(properties) && Object.values(properties).every(isSchemaNode))) &&
    (required === undefined ||
      (Array.isArray(required) && required.every((item) => typeof item === "string")))
  );
}

function isSchemaNode(value: JsonValue): value is OutputToolSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
