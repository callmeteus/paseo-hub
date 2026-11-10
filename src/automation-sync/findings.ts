import type { InsertOrganizationFindingInput } from "../db/types.js";

const STATEMENT_LIMIT = 2_000;
const REPLY_LIMIT = 4_000;
const REPLY_COUNT_LIMIT = 20;
const TOOL_NAME_LIMIT = 200;
const TOOL_RESULT_LIMIT = 8_000;
const QUERY_LIMIT = 500;

export const FINDING_EVIDENCE_MESSAGE =
  "A finding needs the fact, at least one Slack reply, and the tool call that checked it.";

export function parseFinding(
  args: Record<string, unknown>,
): Omit<InsertOrganizationFindingInput, "organizationId"> {
  const statement = requiredText(args["statement"], STATEMENT_LIMIT);
  const replies = replyList(args["replies"]);
  const tool = toolCall(args["tool"]);
  if (statement === undefined || replies === undefined || tool === undefined) {
    throw new FindingInputError(FINDING_EVIDENCE_MESSAGE);
  }
  return { statement, replies, toolName: tool.name, toolResult: tool.result };
}

export function findingQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, QUERY_LIMIT);
}

export function formatFindings(
  findings: readonly {
    statement: string;
    replies: readonly string[];
    toolName: string;
    toolResult: string;
  }[],
): string {
  if (findings.length === 0) return "No findings.";
  return findings
    .map((finding) =>
      [
        finding.statement,
        "Slack replies:",
        ...finding.replies.map((reply) => `- ${reply}`),
        `Tool: ${finding.toolName}`,
        finding.toolResult,
      ].join("\n"),
    )
    .join("\n\n");
}

export class FindingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingInputError";
  }
}

function requiredText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > limit) return undefined;
  return text;
}

function replyList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > REPLY_COUNT_LIMIT) {
    return undefined;
  }
  const replies: string[] = [];
  for (const item of value) {
    const text = requiredText(item, REPLY_LIMIT);
    if (text === undefined) return undefined;
    replies.push(text);
  }
  return replies;
}

function toolCall(value: unknown): { name: string; result: string } | undefined {
  const record = objectRecord(value);
  if (record === undefined) return undefined;
  const name = requiredText(record["name"], TOOL_NAME_LIMIT);
  const result = requiredText(record["result"], TOOL_RESULT_LIMIT);
  if (name === undefined || result === undefined) return undefined;
  return { name, result };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}
