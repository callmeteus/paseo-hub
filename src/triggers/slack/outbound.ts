/**
 * Checks the text of a Slack reply before it reaches the workspace.
 *
 * A Portuguese-speaking workspace reads the answer, so narration in English, a summary of
 * the execution the model just ran, a wall of text, a `file://` link to a machine path
 * that is not the local attachment directory, and a mention that is not a Slack id all
 * have to be rewritten by the model instead of being posted.
 */

/** Directory a local attachment lives in. Only files below it can be uploaded. */
export const LOCAL_ATTACHMENT_DIR_PREFIX = "/tmp/paseo-attachments-" as const;

export const MAX_OUTBOUND_CHARS = 1200;
export const MAX_OUTBOUND_PARAGRAPHS = 3;

/**
 * A Slack reply the model has to rewrite.
 *
 * The capability server returns `reason` as the tool error, so the model can fix the
 * text and call `reply` again.
 */
export class SlackOutboundTextError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SlackOutboundTextError";
  }
}

export type OutboundTextCheck = { ok: true } | { ok: false; reason: string };

/** Portuguese function words. A reply for this workspace is written in Portuguese. */
const PORTUGUESE_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "a",
  "agora",
  "ainda",
  "ao",
  "aos",
  "aquilo",
  "as",
  "assim",
  "até",
  "à",
  "às",
  "antes",
  "cada",
  "com",
  "como",
  "da",
  "das",
  "de",
  "depois",
  "desde",
  "do",
  "dos",
  "e",
  "ela",
  "ele",
  "eles",
  "elas",
  "em",
  "então",
  "era",
  "eram",
  "essa",
  "esse",
  "esta",
  "este",
  "está",
  "estão",
  "eu",
  "foi",
  "fiz",
  "fizemos",
  "fez",
  "há",
  "isso",
  "isto",
  "já",
  "mais",
  "mas",
  "meu",
  "minha",
  "menos",
  "mesmo",
  "muito",
  "na",
  "nas",
  "não",
  "no",
  "nos",
  "num",
  "numa",
  "nada",
  "o",
  "os",
  "onde",
  "ou",
  "outro",
  "outra",
  "para",
  "pela",
  "pelas",
  "pelo",
  "pelos",
  "por",
  "porque",
  "pra",
  "pro",
  "quando",
  "que",
  "seja",
  "sem",
  "ser",
  "seu",
  "só",
  "sobre",
  "sua",
  "são",
  "também",
  "tem",
  "ter",
  "tudo",
  "têm",
  "vai",
  "vamos",
  "vou",
  "é",
]);

/**
 * English function words, plus the verbs of the narration the model writes about itself.
 *
 * Words that are Portuguese too ("a", "no", "as", "mas") are not here: they would count
 * a normal Portuguese reply as English.
 */
const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "about",
  "after",
  "again",
  "all",
  "also",
  "and",
  "any",
  "are",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "each",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "here",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "more",
  "most",
  "must",
  "my",
  "not",
  "now",
  "of",
  "on",
  "only",
  "or",
  "other",
  "out",
  "over",
  "reading",
  "reacting",
  "retry",
  "sending",
  "sent",
  "shall",
  "she",
  "should",
  "so",
  "some",
  "start",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "which",
  "who",
  "why",
  "will",
  "with",
  "without",
  "would",
  "you",
  "your",
]);

/** How many English function words mark the text as English. Below it the text is left alone. */
const MIN_ENGLISH_FUNCTION_WORDS = 3;

/**
 * Narration that describes the execution instead of answering the person.
 *
 * It is read lowercased at the start of any line or paragraph, so a summary the model
 * puts after the first answer is caught too.
 */
const META_MARKERS: readonly string[] = [
  "respondi na thread",
  "respondi no thread",
  "respondi no canal",
  "o que fiz",
  "expliquei na thread",
  "enviei duas respostas",
  "nesta execução",
  "thread fechada",
  "deixei o eyes",
  "encerrei a execução",
  "a execução foi encerrada",
  "now i'll",
  "now let me",
  "i'll",
  "i will",
  "let me",
];

/** A Slack user or workspace-app id. `<@U094VQCSK53>` and `<@W094VQCSK53>` are mentions. */
const SLACK_MENTION_ID = /^[UW][A-Z0-9]{6,}$/u;

/** A Slack id written as plain text, where it names nobody. */
const RAW_SLACK_ID = /\b[UW][A-Z0-9]{8,}\b/u;

const MENTION = /<@([^>|]+)(?:\|([^>]*))?>/gu;
const FILE_LINK = /file:\/\/([^\s>|)]+)/giu;
const SLACK_FILE_LINK = /<file:\/\/(\/tmp\/paseo-attachments-[^\s>|]+)(?:\|[^>]*)?>/gu;
const MARKDOWN_FILE_LINK = /!\[[^\]]*\]\(file:\/\/(\/tmp\/paseo-attachments-[^)\s]+)\)/gu;

/**
 * Decides whether a reply can be posted as it is.
 *
 * Code spans, code blocks, links, and mentions are left out of the language read, so a
 * Portuguese reply that quotes an English error keeps its own language.
 *
 * @param text - The reply the model wrote
 * @returns `ok`, or the reason the model has to rewrite the reply
 */
export function checkOutboundText(text: string): OutboundTextCheck {
  const prose = proseText(text);

  if (text.length > MAX_OUTBOUND_CHARS) {
    return rejection(
      `Resposta longa demais (${String(text.length)} caracteres). Reescreva em português, direto, com no máximo ${String(MAX_OUTBOUND_CHARS)} caracteres.`,
    );
  }

  const paragraphs = countParagraphs(text);
  if (paragraphs > MAX_OUTBOUND_PARAGRAPHS) {
    return rejection(
      `Resposta com ${String(paragraphs)} parágrafos. Reescreva em no máximo ${String(MAX_OUTBOUND_PARAGRAPHS)} parágrafos curtos, em português.`,
    );
  }

  const marker = metaMarker(text);
  if (marker !== undefined) {
    return rejection(
      `Não narre a execução com "${marker}". Escreva em português só a resposta para a pessoa.`,
    );
  }

  if (isMostlyEnglish(prose)) {
    return rejection("Resposta em inglês. Reescreva em português, sem narrar passos da execução.");
  }

  const outsideLink = fileLinkOutsideAttachments(text);
  if (outsideLink !== undefined) {
    return rejection(
      `O link ${outsideLink} não é um anexo local. Use só arquivos de ${LOCAL_ATTACHMENT_DIR_PREFIX}… ou remova o link.`,
    );
  }

  const mention = invalidMention(text);
  if (mention !== undefined) {
    return rejection(
      `A menção ${mention} não é um id do Slack. Use <@U123456789> com o id real, ou só o nome da pessoa.`,
    );
  }

  const rawId = rawSlackId(prose);
  if (rawId !== undefined) {
    return rejection(
      `O id ${rawId} está solto no texto. Use o nome da pessoa ou a menção <@${rawId}>.`,
    );
  }

  return { ok: true };
}

/**
 * Rewrites the parts of a reply there is no model left to fix.
 *
 * A notice is posted after the run, so an invalid mention becomes plain text instead of
 * refusing the post. Everything else is left as it is.
 *
 * @param text - Text that is about to be posted with no retry
 * @returns The same text with invalid mentions written as their label or id
 */
export function sanitizeOutboundText(text: string): string {
  return text.replace(MENTION, (mention, id: unknown, label: unknown) => {
    if (typeof id === "string" && SLACK_MENTION_ID.test(id)) return mention;
    if (typeof label === "string" && label.trim().length > 0) return label;
    return typeof id === "string" ? id : mention;
  });
}

/**
 * Takes the local attachment links out of a reply.
 *
 * `<file:///tmp/paseo-attachments-…|Image>` and `![label](file:///tmp/paseo-attachments-…)`
 * are Slack-hosted uploads after this call, so the link itself must not be posted.
 *
 * @param text - The reply the model wrote
 * @returns The reply without those links, and the local paths in the order they appear
 */
export function extractLocalAttachments(text: string): { text: string; files: string[] } {
  const found: string[] = [];
  for (const pattern of [SLACK_FILE_LINK, MARKDOWN_FILE_LINK]) {
    for (const match of text.matchAll(pattern)) {
      const path = match[1];
      if (path !== undefined) found.push(path);
    }
  }
  const stripped = text
    .replace(SLACK_FILE_LINK, "")
    .replace(MARKDOWN_FILE_LINK, "")
    .replace(/[ \t]+$/gmu, "")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { text: stripped, files: [...new Set(found)] };
}

function rejection(reason: string): OutboundTextCheck {
  return { ok: false, reason };
}

/**
 * Prose of a reply: no code, no links, no mentions.
 *
 * The language read must not count the English inside a stack trace or a URL.
 */
function proseText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/gu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/<@[^>]*>/gu, " ")
    .replace(/\S*:\/\/\S*/gu, " ");
}

function countParagraphs(text: string): number {
  return text
    .replace(/```[\s\S]*?(?:```|$)/gu, " ")
    .split(/\n[ \t]*\n/u)
    .filter((paragraph) => paragraph.trim().length > 0).length;
}

/**
 * The narration marker the reply carries, lowercased.
 *
 * Checked at the start of any line or paragraph, after bullets like `•`, `-`, or `*`:
 * the model also narrates after the answer it already gave.
 */
function metaMarker(text: string): string | undefined {
  for (const paragraph of text.split(/\n/u)) {
    const line = paragraph
      .trim()
      .replace(/^[•\-*–—\s]+/u, "")
      .trim()
      .toLowerCase();
    for (const marker of META_MARKERS) {
      if (line.startsWith(marker)) return marker;
    }
  }
  return undefined;
}

function isMostlyEnglish(prose: string): boolean {
  const words = prose.toLowerCase().match(/\p{L}+/gu) ?? [];
  let portuguese = 0;
  let english = 0;
  for (const word of words) {
    if (PORTUGUESE_FUNCTION_WORDS.has(word)) portuguese += 1;
    if (ENGLISH_FUNCTION_WORDS.has(word)) english += 1;
  }
  return english >= MIN_ENGLISH_FUNCTION_WORDS && english > portuguese;
}

/** The first `file://` link that is not a local attachment, written with its scheme. */
function fileLinkOutsideAttachments(text: string): string | undefined {
  for (const match of text.matchAll(FILE_LINK)) {
    const path = match[1];
    if (path === undefined || path.startsWith(LOCAL_ATTACHMENT_DIR_PREFIX)) continue;
    return `file://${path}`;
  }
  return undefined;
}

/**
 * A Slack id written as plain text instead of as a mention, which names nobody.
 *
 * Read from prose, so an id inside a mention or a URL is left alone.
 */
function rawSlackId(prose: string): string | undefined {
  return prose.match(RAW_SLACK_ID)?.[0];
}

/** The first mention whose id is not a Slack user or app id. */
function invalidMention(text: string): string | undefined {
  for (const match of text.matchAll(MENTION)) {
    const id = match[1];
    if (id === undefined || !SLACK_MENTION_ID.test(id)) return match[0];
  }
  return undefined;
}
