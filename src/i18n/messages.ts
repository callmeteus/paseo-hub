import { z } from "zod";

/**
 * System messages the Hub writes for a person, in the locale the trigger asked for.
 *
 * A message is never assembled from a raw failure reason or a model-authored summary:
 * every sentence a person reads comes from this catalog, so a new locale is one more
 * entry and no product code carries text.
 */

/** Locales the Hub ships system messages in. `en` is the default and the fallback. */
export const SUPPORTED_LOCALES = ["en", "pt-BR"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Values a message may interpolate. Every entry reads the names it declares. */
export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * The keys and the text of one locale.
 *
 * Keys are the stable contract; a locale that lacks one is a compile error, not a
 * runtime surprise.
 */
export interface MessageCatalog {
  "failure.timeout": (params: MessageParams) => string;
  "failure.idle": (params: MessageParams) => string;
  "failure.machine": (params: MessageParams) => string;
  "failure.unknown": (params: MessageParams) => string;
  "outbound.tooLong": (params: MessageParams) => string;
  "outbound.tooManyParagraphs": (params: MessageParams) => string;
  "outbound.narration": (params: MessageParams) => string;
  "outbound.wrongLanguage": (params: MessageParams) => string;
  "outbound.fileLinkOutside": (params: MessageParams) => string;
  "outbound.invalidMention": (params: MessageParams) => string;
  "outbound.rawUserId": (params: MessageParams) => string;
  /** Line replacing a button card after someone clicks one of its buttons. */
  "choice.chosen": (params: MessageParams) => string;
}

export type MessageKey = keyof MessageCatalog;

/**
 * A locale value the schema accepts.
 *
 * Unknown values are refused here, with the accepted list, instead of reaching the
 * catalog and quietly falling back.
 */
export const LocaleSchema = z.enum(SUPPORTED_LOCALES, {
  error: "locale must be en or pt-BR",
});

export const en: MessageCatalog = {
  "failure.timeout": () => "I ran out of time and stopped. The case is still open in this thread.",
  "failure.idle": () =>
    "I stopped after waiting too long without a reply. Mention me again to continue.",
  "failure.machine": () => "I could not start because the machine that runs me is offline.",
  "failure.unknown": () =>
    "I hit a problem and stopped before finishing. Mention me again to retry.",
  "outbound.tooLong": (params) =>
    `Your reply is too long (${text(params, "chars")} characters). Rewrite it in English, directly, in at most ${text(params, "max")} characters.`,
  "outbound.tooManyParagraphs": (params) =>
    `Your reply has ${text(params, "paragraphs")} paragraphs. Rewrite it in at most ${text(params, "max")} short paragraphs, in English.`,
  "outbound.narration": (params) =>
    `Do not narrate the execution with "${text(params, "marker")}". Write only the answer to the person, in English.`,
  "outbound.wrongLanguage": () => "Reply in English, without narrating the steps of the execution.",
  "outbound.fileLinkOutside": (params) =>
    `The link ${text(params, "link")} is not a local attachment. Use only files from ${text(params, "dir")}… or remove the link.`,
  "outbound.invalidMention": (params) =>
    `The mention ${text(params, "mention")} is not a Slack id. Use <@U123456789> with the real id, or just the person's name.`,
  "outbound.rawUserId": (params) =>
    `The id ${text(params, "id")} is loose in the text. Use the person's name or the mention <@${text(params, "id")}>.`,
  "choice.chosen": (params) => `${text(params, "user")} chose "${text(params, "choice")}"`,
};

export const ptBR: MessageCatalog = {
  "failure.timeout": () =>
    "Não terminei a tempo e parei por aqui. O caso continua aberto nesta thread.",
  "failure.idle": () =>
    "Fiquei sem resposta por muito tempo e parei. Me marque de novo para continuar.",
  "failure.machine": () =>
    "Não consegui começar agora porque a máquina que me roda está fora. Avise quem cuida do Hub.",
  "failure.unknown": () =>
    "Tive um problema e parei antes de terminar. Me marque de novo para tentar outra vez.",
  "outbound.tooLong": (params) =>
    `Resposta longa demais (${text(params, "chars")} caracteres). Reescreva em português, direto, com no máximo ${text(params, "max")} caracteres.`,
  "outbound.tooManyParagraphs": (params) =>
    `Resposta com ${text(params, "paragraphs")} parágrafos. Reescreva em no máximo ${text(params, "max")} parágrafos curtos, em português.`,
  "outbound.narration": (params) =>
    `Não narre a execução com "${text(params, "marker")}". Escreva em português só a resposta para a pessoa.`,
  "outbound.wrongLanguage": () =>
    "Resposta em inglês. Reescreva em português, sem narrar passos da execução.",
  "outbound.fileLinkOutside": (params) =>
    `O link ${text(params, "link")} não é um anexo local. Use só arquivos de ${text(params, "dir")}… ou remova o link.`,
  "outbound.invalidMention": (params) =>
    `A menção ${text(params, "mention")} não é um id do Slack. Use <@U123456789> com o id real, ou só o nome da pessoa.`,
  "outbound.rawUserId": (params) =>
    `O id ${text(params, "id")} está solto no texto. Use o nome da pessoa ou a menção <@${text(params, "id")}>.`,
  "choice.chosen": (params) => `${text(params, "user")} escolheu "${text(params, "choice")}"`,
};

export const catalogs: Readonly<Record<Locale, MessageCatalog>> = {
  en,
  "pt-BR": ptBR,
};

/** Every key in the catalog, so a test can check each locale has all of them. */
export const MESSAGE_KEYS: readonly MessageKey[] = [
  "failure.timeout",
  "failure.idle",
  "failure.machine",
  "failure.unknown",
  "outbound.tooLong",
  "outbound.tooManyParagraphs",
  "outbound.narration",
  "outbound.wrongLanguage",
  "outbound.fileLinkOutside",
  "outbound.invalidMention",
  "outbound.rawUserId",
  "choice.chosen",
];

/**
 * The catalog locale for a stored value.
 *
 * Absent, unsupported, and unknown values read as `en`, so a configuration written by
 * another version never leaves a person without a sentence.
 *
 * @param value - Locale recorded on the trigger or execution
 * @returns A shipped locale
 */
export function localeOf(value: string | undefined): Locale {
  return value === "pt-BR" ? value : DEFAULT_LOCALE;
}

/**
 * One system sentence, in the requested locale and falling back to `en`.
 *
 * @param locale - Locale of the trigger, or undefined for the default
 * @param key - Catalog key
 * @param params - Values the entry interpolates
 * @returns The sentence a person reads
 */
export function message(
  locale: string | undefined,
  key: MessageKey,
  params: MessageParams = {},
): string {
  return catalogs[localeOf(locale)][key](params);
}

/**
 * A required interpolation value, written as text.
 *
 * A missing value is a programming error in the call site, so it throws instead of
 * leaving `undefined` in a sentence a person reads.
 */
function text(params: MessageParams, name: string): string {
  const found = params[name];
  if (found === undefined) throw new Error(`message parameter is missing: ${name}`);
  return String(found);
}
