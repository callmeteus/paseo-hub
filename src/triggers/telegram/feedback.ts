/**
 * Inline-keyboard buttons attached to a finished Telegram card.
 *
 * `callback_data` carries the choice value, so a click comes back as a `callback_query`.
 * Mirrors the Slack `feedback` surface: at most five buttons, and the arrival sentence
 * the next turn receives is the same wording.
 */

export const TELEGRAM_CHOICE_LIMIT = 5;

export interface TelegramChoice {
  label: string;
  value: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** The sentence the next turn receives after a button click. */
export function telegramChoiceArrival(choice: Pick<TelegramChoice, "label" | "value">): string {
  if (choice.label === choice.value) return `The person chose "${choice.label}".`;
  return `The person chose "${choice.label}" (${choice.value}).`;
}

/** Renders choices as one row of inline-keyboard buttons. */
export function telegramChoiceKeyboard(choices: readonly TelegramChoice[]): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      choices.map((choice) => ({ text: choice.label, callback_data: choice.value })),
    ],
  };
}

/**
 * Tries to read a choice back from a callback query's data.
 *
 * Only our button values are accepted; everything else is ignored so other bots'
 * callbacks cannot start a run.
 */
export function telegramChoiceFromCallback(
  data: string | undefined,
  allowed: readonly TelegramChoice[] = [],
): TelegramChoice | undefined {
  if (data === undefined || data.length === 0 || data.length > 200) return undefined;
  if (allowed.length > 0) {
    const found = allowed.find((choice) => choice.value === data);
    return found === undefined ? undefined : { label: found.label, value: found.value };
  }
  return { label: data, value: data };
}
