import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  DEFAULT_LOCALE,
  LocaleSchema,
  MESSAGE_KEYS,
  catalogs,
  localeOf,
  message,
  SUPPORTED_LOCALES,
} from "./messages.js";

describe("message catalog", () => {
  it("writes the English sentence by default", () => {
    assert.equal(DEFAULT_LOCALE, "en");
    assert.equal(
      message(undefined, "failure.timeout"),
      "I ran out of time and stopped. The case is still open in this thread.",
    );
  });

  it("writes the sentence in pt-BR when asked", () => {
    assert.equal(
      message("pt-BR", "failure.machine"),
      "Não consegui começar agora porque a máquina que me roda está fora. Avise quem cuida do Hub.",
    );
  });

  it("falls back to English for an unknown locale", () => {
    assert.equal(
      message("xx-YY", "failure.idle"),
      "I stopped after waiting too long without a reply. Mention me again to continue.",
    );
    assert.equal(localeOf("xx-YY"), "en");
    assert.equal(localeOf(undefined), "en");
    assert.equal(localeOf("pt-BR"), "pt-BR");
  });

  it("interpolates the values a reason needs", () => {
    assert.equal(
      message("en", "outbound.tooManyParagraphs", { paragraphs: 4, max: 3 }),
      "Your reply has 4 paragraphs. Rewrite it in at most 3 short paragraphs, in English.",
    );
    assert.equal(
      message("pt-BR", "outbound.invalidMention", { mention: "<@phone-home>" }),
      "A menção <@phone-home> não é um id do Slack. Use <@U123456789> com o id real, ou só o nome da pessoa.",
    );
  });

  it("has every key in every locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      assert.deepEqual(Object.keys(catalogs[locale]).sort(), [...MESSAGE_KEYS].sort(), locale);
    }
  });

  it("names no person in the product text", () => {
    const params = {
      chars: 1,
      max: 1,
      paragraphs: 1,
      marker: "x",
      link: "x",
      dir: "x",
      mention: "x",
      id: "x",
    };
    for (const locale of SUPPORTED_LOCALES) {
      const catalog = catalogs[locale];
      const text = MESSAGE_KEYS.map((key) => catalog[key](params)).join(" ");
      assert.equal(text.includes("Gio"), false, locale);
    }
  });

  it("accepts the shipped locales and refuses the rest with a clear error", () => {
    assert.equal(LocaleSchema.safeParse("en").success, true);
    assert.equal(LocaleSchema.safeParse("pt-BR").success, true);
    const refused = LocaleSchema.safeParse("xx-YY");
    assert.equal(refused.success, false);
    assert.match(refused.error?.issues[0]?.message ?? "", /locale must be en or pt-BR/u);
  });
});
