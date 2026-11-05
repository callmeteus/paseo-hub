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

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_.]*/u;
const MAX_ENV_DEPTH = 8;

export interface EnvInterpolation {
  text: string;
  /** Values taken from the files. Used to redact an error, never stored. */
  secrets: readonly string[];
}

/**
 * Merges dotenv files in order. The first file that has a key keeps it.
 *
 * A path that starts with `~/` is under `home`. A missing file is skipped.
 * Empty values are skipped. Nothing is logged.
 *
 * @param files - Dotenv paths, in the order the workflow wrote them
 * @param home - Home directory used to expand `~/`
 * @returns The merged keys
 */
export function loadEnvFiles(
  files: readonly string[],
  home: string,
): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const file of files) {
    const values = readDotenv(expandHome(file, home));
    for (const [key, value] of Object.entries(values)) {
      if (value.length === 0 || merged[key] !== undefined) continue;
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Replaces `${var:KEY}` from a merged dotenv map.
 *
 * `var:` is the only prefix. The key is the literal dotenv key, and it may
 * contain a dot. This does not take a workflow `${{ ... }}`.
 * `${var:KEY:-fallback}` is used when the value is missing or empty, and the
 * fallback is interpolated too. `${var:KEY-fallback}` is used only when the
 * value is missing. `$$` stays as `$`. A missing required key throws, and the
 * message names the key without its value.
 *
 * @param template - Text that may contain `${var:KEY}`
 * @param env - Merged dotenv values
 * @param depth - Nested fallback depth
 * @returns The text and the secret values that were inserted
 */
export function interpolateEnv(
  template: string,
  env: Readonly<Record<string, string>>,
  depth = 0,
): EnvInterpolation {
  if (depth > MAX_ENV_DEPTH) throw new Error("env interpolation is too deep");
  let text = "";
  const secrets: string[] = [];
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] !== "$") {
      text += template[index];
      continue;
    }
    if (template[index + 1] === "$") {
      text += "$";
      index += 1;
      continue;
    }
    if (template[index + 1] !== "{") {
      text += "$";
      continue;
    }
    // ${{ is a workflow expression. Leave it for that renderer.
    if (template[index + 2] === "{") {
      text += "$";
      continue;
    }
    const expression = readEnvExpression(template, index + 2);
    const resolved = resolveEnvExpression(expression, env, depth);
    text += resolved.text;
    secrets.push(...resolved.secrets);
    index = expression.end;
  }
  return { text, secrets };
}

interface EnvExpression {
  name: string;
  /** Set when the expression has a fallback. True when an empty value also falls back. */
  whenEmpty?: boolean | undefined;
  fallback?: string | undefined;
  /** Index of the closing brace. */
  end: number;
}

function readEnvExpression(template: string, start: number): EnvExpression {
  if (!template.startsWith("var:", start)) throw new Error("interpolation must use var:KEY");
  const nameStart = start + "var:".length;
  const name = VAR_NAME.exec(template.slice(nameStart))?.[0];
  if (name === undefined) throw new Error("interpolation is missing a key");
  let cursor = nameStart + name.length;
  if (template[cursor] === "}") return { name, end: cursor };
  let whenEmpty = false;
  if (template[cursor] === ":") {
    if (template[cursor + 1] !== "-") throw new Error("interpolation has an unknown operator");
    whenEmpty = true;
    cursor += 2;
  } else if (template[cursor] === "-") {
    cursor += 1;
  } else {
    throw new Error("interpolation is missing a closing brace");
  }
  const fallback = readUntilBrace(template, cursor);
  return { name, whenEmpty, fallback: fallback.text, end: fallback.end };
}

function readUntilBrace(template: string, start: number): { text: string; end: number } {
  let depth = 0;
  for (let index = start; index < template.length; index += 1) {
    if (template[index] === "$" && template[index + 1] === "$") {
      index += 1;
      continue;
    }
    if (template[index] === "$" && template[index + 1] === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (template[index] !== "}") continue;
    if (depth === 0) return { text: template.slice(start, index), end: index };
    depth -= 1;
  }
  throw new Error("interpolation is missing a closing brace");
}

function resolveEnvExpression(
  expression: EnvExpression,
  env: Readonly<Record<string, string>>,
  depth: number,
): EnvInterpolation {
  const value = env[expression.name];
  if (value !== undefined && value.length > 0) return { text: value, secrets: [value] };
  const unset = value === undefined;
  if (expression.fallback !== undefined && (expression.whenEmpty === true || unset)) {
    return interpolateEnv(expression.fallback, env, depth + 1);
  }
  // ${var:KEY-fallback} keeps an empty value. A required key does not.
  if (value === "" && expression.fallback !== undefined) return { text: "", secrets: [] };
  throw new Error(`var:${expression.name} is unset`);
}

function expandHome(file: string, home: string): string {
  if (file === "~") return home;
  if (file.startsWith("~/")) return join(home, file.slice(2));
  return file;
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
  headers: Readonly<Record<string, string>>;
  secrets: readonly string[];
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
        ...input.headers,
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
    if (!response.ok) return { ok: false, reason: await failureReason(response, input.secrets) };
    return { ok: true, output: { assigned: true } };
  }
  if (!response.ok) return { ok: false, reason: await failureReason(response, input.secrets) };
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
 * The bot connected to this automation is the one executing the deploy, so the
 * API records that bot. The card is often posted by a different app, and the
 * person named on the card stays the requester. Sending either of those ids is
 * rejected when they are not members of the team that owns the route.
 *
 * A run without a bot, such as a manual one, still uses the requester written
 * as `por <@U...>` in the message. It does not fall back to the message author.
 *
 * @param prompt - Trigger message
 * @param triggerContext - Provider context for the run
 * @returns Slack user id, when one is present
 */
export function deployActor(prompt: string, triggerContext: unknown): string | undefined {
  const bot = slackBotUser(triggerContext);
  if (bot !== undefined && SLACK_USER.test(bot)) return bot;
  return REQUESTER.exec(prompt)?.[1];
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

function slackBotUser(triggerContext: unknown): string | undefined {
  if (!isRecord(triggerContext)) return undefined;
  const event = triggerContext["event"];
  if (!isRecord(event)) return undefined;
  const slack = event["slack"];
  if (!isRecord(slack)) return undefined;
  const bot = slack["bot"];
  if (!isRecord(bot)) return undefined;
  return typeof bot["id"] === "string" ? bot["id"] : undefined;
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

async function failureReason(response: Response, secrets: readonly string[]): Promise<string> {
  let text = await response.text();
  const hidden = [...secrets]
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const secret of hidden) text = text.replaceAll(secret, "[redacted]");
  text = text.slice(0, 200);
  return `deploy api returned ${String(response.status)}${text.length === 0 ? "" : `: ${text}`}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
