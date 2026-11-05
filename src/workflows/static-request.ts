import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEPLOY_NUMBER = /#(\d+)/u;
const REQUESTER = /por\s+<@(U[A-Z0-9]+)>/u;
const SLACK_USER = /^U[A-Z0-9]+$/u;
const MAX_BODY_CHARS = 200_000;

export interface DeployHttpStep {
  method: "GET" | "POST";
  url: string;
  path?: "assign" | undefined;
}

export type DeployHttpResult =
  | { ok: true; output: Readonly<Record<string, unknown>> }
  | { ok: false; reason: string };

/**
 * Reads the E7 API key from the Lemon credentials files.
 *
 * `~/.lm.credentials` wins when it has the key. Otherwise `~/.lemon.credentials`.
 * The file is dotenv. The key is `EVEN_AGENT_API_KEY`, or `e7.apiKey`.
 *
 * @param home - Home directory that holds the credentials files
 * @returns The API key
 */
export function readE7ApiKey(home: string): string {
  const preferred = readDotenv(join(home, ".lm.credentials"));
  const fallback = readDotenv(join(home, ".lemon.credentials"));
  const key =
    preferred["EVEN_AGENT_API_KEY"] ??
    preferred["e7.apiKey"] ??
    fallback["EVEN_AGENT_API_KEY"] ??
    fallback["e7.apiKey"];
  if (key === undefined || key.length === 0) {
    throw new Error("e7 api key is missing from the credentials file");
  }
  return key;
}

/**
 * Calls the deploy API and returns the fields the workflow branches on.
 *
 * A GET reports whether the deploy is still free. A POST assigns it. HTTP 409
 * on assign means someone else took it, which is a result, not a failed step.
 *
 * @param input - Request, prompt, actor source, key, and fetch
 * @returns The step output, or a reason the step failed
 */
export async function callDeployHttp(input: {
  step: DeployHttpStep;
  prompt: string;
  triggerContext: unknown;
  apiKey: string;
  fetch: typeof fetch;
}): Promise<DeployHttpResult> {
  if (input.step.method === "POST" && input.step.path !== "assign") {
    return { ok: false, reason: "assign requires POST" };
  }
  const number = deployNumber(input.prompt);
  if (number === undefined)
    return { ok: false, reason: "deploy number is missing from the message" };
  const actor = deployActor(input.prompt, input.triggerContext);
  if (actor === undefined) return { ok: false, reason: "slack user for this deploy is missing" };
  let url: string;
  try {
    url = deployUrl(input.step.url, number, input.step.path);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "deploy url is invalid" };
  }
  let response: Response;
  try {
    response = await input.fetch(url, {
      method: input.step.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiKey}`,
        "x-sanddbox-actor": actor,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "deploy request failed";
    return { ok: false, reason: `deploy request failed: ${message}` };
  }
  if (input.step.method === "POST") {
    if (response.status === 409) return { ok: true, output: { assigned: false } };
    if (!response.ok) return { ok: false, reason: await failureReason(response, input.apiKey) };
    return { ok: true, output: { assigned: true } };
  }
  if (!response.ok) return { ok: false, reason: await failureReason(response, input.apiKey) };
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: "deploy response is not json" };
  }
  const encoded = JSON.stringify(parsed);
  if (encoded.length > MAX_BODY_CHARS) return { ok: false, reason: "deploy response is too large" };
  const fields = readDeployFields(parsed);
  const open = fields.status.toUpperCase() === "AWAITING" && fields.assignedTo === null;
  return {
    ok: true,
    output: {
      number,
      status: fields.status,
      assignedTo: fields.assignedTo,
      assignee: fields.assignedTo === null ? "" : ` e foi assumido por <@${fields.assignedTo}>`,
      open,
      body: parsed,
    },
  };
}

/**
 * The deploy number written in the Slack card, such as `#848`.
 *
 * @param prompt - Trigger message
 * @returns The digits, when the card has them
 */
export function deployNumber(prompt: string): string | undefined {
  return DEPLOY_NUMBER.exec(prompt)?.[1];
}

/**
 * The Slack user the deploy API should see.
 *
 * A new card is posted by the bot and names the requester as `por <@U...>`.
 * That person is the actor. A mention falls back to the message author.
 *
 * @param prompt - Trigger message
 * @param triggerContext - Provider context for the run
 * @returns Slack user id, when one is present
 */
export function deployActor(prompt: string, triggerContext: unknown): string | undefined {
  const requester = REQUESTER.exec(prompt)?.[1];
  if (requester !== undefined) return requester;
  const author = slackAuthor(triggerContext);
  return author !== undefined && SLACK_USER.test(author) ? author : undefined;
}

function deployUrl(base: string, number: string, path: "assign" | undefined): string {
  const trimmed = base.replace(/\/$/u, "");
  const target = `${trimmed}/${number}${path === "assign" ? "/assign" : ""}`;
  const parsed = new URL(target);
  if (parsed.protocol !== "https:") throw new Error("deploy url must be https");
  return parsed.toString();
}

function readDeployFields(body: unknown): { status: string; assignedTo: string | null } {
  if (!isRecord(body)) return { status: "", assignedTo: null };
  const status = typeof body["status"] === "string" ? body["status"] : "";
  const assigned = body["assignedTo"];
  const assignedTo =
    typeof assigned === "string" && assigned.trim().length > 0 ? assigned.trim() : null;
  return { status, assignedTo };
}

function slackAuthor(triggerContext: unknown): string | undefined {
  if (!isRecord(triggerContext)) return undefined;
  const event = triggerContext["event"];
  if (!isRecord(event)) return undefined;
  const slack = event["slack"];
  if (!isRecord(slack)) return undefined;
  const message = slack["trigger_message"];
  if (!isRecord(message)) return undefined;
  const author = message["author"];
  if (!isRecord(author)) return undefined;
  return typeof author["id"] === "string" ? author["id"] : undefined;
}

function readDotenv(path: string): Readonly<Record<string, string>> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf("=");
    if (split < 0) continue;
    const key = trimmed.slice(0, split).trim();
    let value = trimmed.slice(split + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function failureReason(response: Response, apiKey: string): Promise<string> {
  const text = (await response.text()).replaceAll(apiKey, "[redacted]").slice(0, 200);
  return `deploy api returned ${String(response.status)}${text.length === 0 ? "" : `: ${text}`}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
