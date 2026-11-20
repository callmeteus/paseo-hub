import { describe, expect, it } from "vitest";
import {
  TELEGRAM_CHOICE_LIMIT,
  telegramChoiceArrival,
  telegramChoiceFromCallback,
  telegramChoiceKeyboard,
} from "./feedback.js";

describe("telegram feedback", () => {
  it("caps choices at five", () => {
    expect(TELEGRAM_CHOICE_LIMIT).toBe(5);
  });

  it("renders an inline keyboard with callback_data equal to the choice value", () => {
    const keyboard = telegramChoiceKeyboard([
      { label: "Sim", value: "deploy_move_crosscheck" },
      { label: "Não", value: "cve_na" },
    ]);
    expect(keyboard).toEqual({
      inline_keyboard: [
        [
          { text: "Sim", callback_data: "deploy_move_crosscheck" },
          { text: "Não", callback_data: "cve_na" },
        ],
      ],
    });
  });

  it("builds the arrival sentence with label and value", () => {
    expect(telegramChoiceArrival({ label: "Aprovar", value: "yes" })).toBe(
      'The person chose "Aprovar" (yes).',
    );
  });

  it("uses the short form when label equals value", () => {
    expect(telegramChoiceArrival({ label: "ok", value: "ok" })).toBe('The person chose "ok".');
  });

  it("reads a callback back against the allowed choices", () => {
    const choices = [{ label: "Aprovar", value: "yes" }];
    expect(telegramChoiceFromCallback("yes", choices)).toEqual(choices[0]);
    expect(telegramChoiceFromCallback("other", choices)).toBeUndefined();
    expect(telegramChoiceFromCallback(undefined, choices)).toBeUndefined();
  });
});
