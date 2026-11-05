import { z } from "zod";

const BOUNDARY_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const BOUNDARY_AFTER = String.raw`(?![\p{L}\p{N}])`;

/**
 * One form line that is a regular expression. The expression is the rest of the line.
 * A plain line is literal text, so a stored literal that starts with this prefix stays in YAML.
 */
const REGEX_FIELD_LINE = /^regex:[ \t]?(.*)$/u;

/**
 * Slack message patterns. Every expression has to match. An empty list is rejected.
 *
 * Expressions are compiled with the Unicode flag, so `\p{L}` works. Case-insensitive
 * text is an inline `(?i:...)` group. The author writes `^` when the match must be a prefix.
 */
export const SlackMessageRegexSchema = z
  .array(z.string().min(1))
  .min(1, "Slack message regex must not be empty.")
  .superRefine((expressions, context) => {
    for (const [index, expression] of expressions.entries()) {
      try {
        compileSlackMessageRegex(expression);
      } catch (error) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: error instanceof Error ? error.message : "Invalid Slack message regex.",
        });
      }
    }
  });

/** One `text` entry: a literal string, or a map whose only field is a regular expression. */
export type SlackTextItem = string | { readonly regex: string };

/**
 * Literal text and regular expressions that must all match the raw Slack message.
 *
 * A string is literal. `{ regex }` is compiled as a regular expression. An empty list,
 * an empty string, an empty expression, and any other shape are rejected.
 */
export const SlackMessageTextSchema = z
  .array(z.unknown())
  .min(1, "Slack message text must not be empty.")
  .superRefine((items, context) => {
    for (const [index, item] of items.entries()) {
      const message = slackTextItemError(item);
      if (message === undefined) continue;
      context.addIssue({ code: "custom", path: [index], message });
    }
  })
  .transform((items): SlackTextItem[] => items.map((item) => readSlackTextItem(item)));

/** Text fields the Slack compiler can turn into `regex`. Other providers keep their own fields. */
export interface SlackTextFilterInput {
  pattern?: string | undefined;
  contains?: string | undefined;
  contains_all?: readonly string[] | undefined;
  contains_any?: readonly string[] | undefined;
  regex?: readonly string[] | undefined;
  text?: readonly SlackTextItem[] | undefined;
}

/** One line of the message field. `regex` is the expression after the `regex:` prefix. */
export interface SlackMessageFieldLine {
  kind: "literal" | "regex";
  value: string;
}

/**
 * Compiles one Slack message expression.
 *
 * A leading `(?i)` is the case-insensitive flag for the rest of the expression.
 * `(?i:...)` stays an inline group and is compiled unchanged. The Unicode flag is always on,
 * so `\p{L}` works.
 *
 * @param expression - Expression from the trigger document
 * @returns A Unicode regular expression
 * @throws When the expression is not a valid Unicode regular expression
 */
export function compileSlackMessageRegex(expression: string): RegExp {
  const flagged = /^\(\?i\)([\s\S]*)$/u.exec(expression);
  const source = flagged?.[1] ?? expression;
  if (flagged !== null && source.length === 0) {
    throw new Error(`Invalid Slack message regex ${JSON.stringify(expression)}: empty pattern`);
  }
  try {
    return new RegExp(source, flagged === null ? "u" : "iu");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid regular expression";
    throw new Error(`Invalid Slack message regex ${JSON.stringify(expression)}: ${detail}`, {
      cause: error,
    });
  }
}

/**
 * Compiles every Slack text clause before any of them is tested.
 *
 * `regex` contributes one expression per string. `text` contributes a literal clause or the
 * expression inside `{ regex }`. Every clause has to match. When both fields are set, the
 * clauses are combined. When both are absent, there is no text filter.
 *
 * @param filters - Authored or compiled filters
 * @returns One compiled clause per item, or undefined when the trigger does not filter on text
 * @throws When a list is empty, an item has the wrong shape, or an expression does not compile
 */
export function compileSlackTextClauses(
  filters: SlackTextFilterInput,
): readonly RegExp[] | undefined {
  const expressions = readExpressionList(filters.regex);
  const items = readTextItems(filters.text);
  if (expressions === undefined && items === undefined) return undefined;
  const compiled: RegExp[] = [];
  if (expressions !== undefined) {
    for (const expression of expressions) compiled.push(compileSlackMessageRegex(expression));
  }
  if (items !== undefined) {
    for (const item of items) compiled.push(compileTextItem(item));
  }
  return compiled;
}

/**
 * The `regex` list equivalent to legacy Slack text fields, when the document has not set `regex` or `text`.
 *
 * Each `contains_all` term becomes one case-insensitive expression with a letter or number
 * boundary. `contains_any` becomes one alternation with that boundary. `pattern`, or `contains`
 * when `pattern` is absent, becomes a case-sensitive prefix anchored to the start of the message.
 * The caller tests the raw message and does not also apply the old prefix rule.
 *
 * @param filters - Authored or compiled filters
 * @returns Expressions that must all match, or undefined when there is nothing to migrate
 */
export function legacySlackTextRegex(filters: SlackTextFilterInput): readonly string[] | undefined {
  if (filters.regex !== undefined || filters.text !== undefined) return undefined;
  const expressions: string[] = [];
  for (const term of textTerms(filters.contains_all)) {
    expressions.push(caseInsensitiveTerm(term));
  }
  const accepted = textTerms(filters.contains_any);
  if (accepted.length > 0) expressions.push(caseInsensitiveAny(accepted));
  const marker = textMarker(filters.pattern) ?? textMarker(filters.contains);
  if (marker !== undefined) expressions.push(anchoredPrefix(marker));
  return expressions.length === 0 ? undefined : expressions;
}

/**
 * Copies a Slack trigger so matching can read `regex` when the document still has the old fields.
 *
 * A trigger that already sets `regex` or `text` is unchanged, including a stored `regex` list.
 * GitHub, Discord, and Linear triggers are unchanged, including their `contains` and `exclude_contains` fields.
 *
 * @param trigger - One authored or compiled trigger
 * @returns The same trigger, or a copy whose Slack filters include `regex`
 */
export function migrateSlackTextFilter<
  T extends { on: string; filters?: SlackTextFilterInput | undefined },
>(trigger: T): T {
  if (trigger.on !== "slack.message" && trigger.on !== "slack.mention") return trigger;
  const filters = trigger.filters;
  if (filters === undefined) return trigger;
  const regex = legacySlackTextRegex(filters);
  if (regex === undefined) return trigger;
  return { ...trigger, filters: { ...filters, regex: [...regex] } };
}

/**
 * The message field for one Slack event, one item per line.
 *
 * A literal is the line itself. A regular expression is a line that starts with `regex:`.
 * `filters.text` is shown first, then each string in `filters.regex`. A line break, surrounding
 * space, or a literal that starts with `regex:` cannot be shown, so the document stays in YAML.
 *
 * @param filters - `text` and `regex` from the document, when the event has them
 * @returns The field text, an empty string when the event does not filter on text, or undefined
 * when the form must not edit it
 */
export function slackMessageFieldText(filters: {
  text?: unknown;
  regex?: unknown;
}): string | undefined {
  if (filters.text === undefined && filters.regex === undefined) return "";
  const lines: string[] = [];
  if (filters.text !== undefined) {
    const textLines = textFieldLines(filters.text);
    if (textLines === undefined) return undefined;
    lines.push(...textLines);
  }
  if (filters.regex !== undefined) {
    const regexLines = regexFieldLines(filters.regex);
    if (regexLines === undefined) return undefined;
    lines.push(...regexLines);
  }
  return lines.join("\n");
}

/**
 * Splits the message field. A blank line is dropped. A line that starts with `regex:` is an
 * expression, and the rest of the line is kept as written. Any other line is literal text.
 *
 * @param value - Field text
 * @returns One entry per non-blank line, in order
 */
export function parseSlackMessageField(value: string): SlackMessageFieldLine[] {
  const lines: SlackMessageFieldLine[] = [];
  for (const raw of value.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim().length === 0) continue;
    const regex = REGEX_FIELD_LINE.exec(line);
    if (regex !== null) {
      lines.push({ kind: "regex", value: regex[1] ?? "" });
      continue;
    }
    lines.push({ kind: "literal", value: line.trim() });
  }
  return lines;
}

/**
 * Filter keys for a message field the user changed.
 *
 * Lines that are all expressions stay on `regex`, which is how a stored expression list is written.
 * A literal line, alone or beside an expression, is written as `text` in field order. An empty
 * expression fails here instead of being stored.
 *
 * @param value - Field text, when the form has it
 * @returns `regex`, `text`, or neither when the field is empty
 * @throws When an expression is empty or is not a valid Unicode regular expression
 */
export function slackFiltersFromField(value: string | undefined): {
  text?: SlackTextItem[];
  regex?: string[];
} {
  const lines = parseSlackMessageField(value ?? "");
  if (lines.length === 0) return {};
  const expressions = lines.flatMap((line) =>
    line.kind === "regex" ? [checkedExpression(line.value)] : [],
  );
  if (expressions.length === lines.length) return { regex: expressions };
  return {
    text: lines.map((line) =>
      line.kind === "literal" ? line.value : { regex: checkedExpression(line.value) },
    ),
  };
}

/**
 * Why one `text` item cannot be stored, when it cannot.
 *
 * @param value - One list item from the document or a compiled config
 * @returns The error, or undefined when the item is a non-empty literal or a compiling expression
 */
export function slackTextItemError(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length === 0 ? "Slack message text must not be empty." : undefined;
  }
  if (!isRegexClause(value)) return "Slack message text must be a string or a regex.";
  if (value.regex.length === 0) return "Slack message regex must not be empty.";
  try {
    compileSlackMessageRegex(value.regex);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid Slack message regex.";
  }
}

function readSlackTextItem(value: unknown): SlackTextItem {
  const message = slackTextItemError(value);
  if (message !== undefined) throw new Error(message);
  if (typeof value === "string") return value;
  if (!isRegexClause(value)) throw new Error("Slack message text must be a string or a regex.");
  return { regex: value.regex };
}

function readExpressionList(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Slack message regex must not be empty.");
  }
  const expressions: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("Slack message regex must not be empty.");
    }
    expressions.push(item);
  }
  return expressions;
}

function readTextItems(
  value: readonly SlackTextItem[] | undefined,
): readonly SlackTextItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Slack message text must be a list.");
  if (value.length === 0) throw new Error("Slack message text must not be empty.");
  const items: SlackTextItem[] = [];
  for (const item of value) items.push(readSlackTextItem(item));
  return items;
}

function compileTextItem(item: SlackTextItem): RegExp {
  if (typeof item === "string") return compileSlackLiteralText(item);
  return compileSlackMessageRegex(item.regex);
}

/**
 * A literal clause. The term is escaped, so characters such as `.` and `:` stay literal,
 * and the user's string is not compiled as a regular expression.
 */
function compileSlackLiteralText(term: string): RegExp {
  return compileSlackMessageRegex(caseInsensitiveTerm(term));
}

function textFieldLines(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const lines: string[] = [];
  for (const item of value) {
    const line = textItemLine(item);
    if (line === undefined) return undefined;
    lines.push(line);
  }
  return lines;
}

function regexFieldLines(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const lines: string[] = [];
  for (const expression of value) {
    if (typeof expression !== "string") return undefined;
    const line = regexLine(expression);
    if (line === undefined) return undefined;
    lines.push(line);
  }
  return lines;
}

function textItemLine(item: unknown): string | undefined {
  if (typeof item === "string") {
    if (item.length === 0 || item !== item.trim() || /[\r\n]/u.test(item)) return undefined;
    if (REGEX_FIELD_LINE.test(item)) return undefined;
    return item;
  }
  if (!isRegexClause(item)) return undefined;
  return regexLine(item.regex);
}

function regexLine(expression: string): string | undefined {
  if (expression.length === 0 || expression !== expression.trim() || /[\r\n]/u.test(expression)) {
    return undefined;
  }
  return `regex: ${expression}`;
}

function checkedExpression(expression: string): string {
  if (expression.length === 0) throw new Error("Slack message regex must not be empty.");
  compileSlackMessageRegex(expression);
  return expression;
}

function caseInsensitiveTerm(term: string): string {
  return `(?i:${BOUNDARY_BEFORE}${escapeRegex(term)}${BOUNDARY_AFTER})`;
}

function caseInsensitiveAny(terms: readonly string[]): string {
  return `(?i:${BOUNDARY_BEFORE}(?:${terms.map((term) => escapeRegex(term)).join("|")})${BOUNDARY_AFTER})`;
}

function anchoredPrefix(marker: string): string {
  return `^${escapeRegex(marker)}(?!\\S)`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textTerms(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  return value.filter((term) => term.length > 0);
}

function textMarker(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function isRegexClause(value: unknown): value is { regex: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const expression: unknown = Reflect.get(value, "regex");
  return keys.length === 1 && keys[0] === "regex" && typeof expression === "string";
}
