import { describe, expect, it } from "vitest";
import type { TelegramBotApi } from "../../providers/telegram/client.js";
import { sendTelegramText, toTelegramHtml } from "./markdown.js";

describe("telegram markdown to HTML", () => {
  it("renders inline code, code blocks, bold, italic, links and escapes stray markup", () => {
    const source = [
      "Versão `6.12.117-1` e `uname -r`.",
      "**negrito** e *itálico* e _itálico_",
      "```",
      "uname -r",
      "```",
      "[cve.now](https://cve.now/CVE-2026-99288) e 7.0.0 < 7.3.4 & 6.8.",
    ].join("\n");
    const html = toTelegramHtml(source);
    expect(html).toContain("<code>6.12.117-1</code>");
    expect(html).toContain("<code>uname -r</code>");
    expect(html).toContain("<pre>uname -r</pre>");
    expect(html).toContain("<b>negrito</b>");
    expect(html).toContain("<i>itálico</i>");
    expect(html).toContain('<a href="https://cve.now/CVE-2026-99288">cve.now</a>');
    expect(html).toContain("7.0.0 &lt; 7.3.4 &amp; 6.8");
    expect(html).not.toContain("`");
  });

  it("does not italicize underscores inside words, usernames or URLs", () => {
    expect(toTelegramHtml("o campo slack_user_id e team_member_id")).toBe(
      "o campo slack_user_id e team_member_id",
    );
    expect(toTelegramHtml("@some_user_name escolheu")).toBe("@some_user_name escolheu");
    expect(toTelegramHtml("veja https://x.com/my_cool_handle/status/1")).toBe(
      "veja https://x.com/my_cool_handle/status/1",
    );
  });

  it("keeps a bare URL and its label untouched", () => {
    expect(toTelegramHtml("CVE-2026-99288 (https://cve.now/CVE-2026-99288)")).toBe(
      "CVE-2026-99288 (https://cve.now/CVE-2026-99288)",
    );
  });

  it("renders list bullets and headings", () => {
    expect(toTelegramHtml("* item um\n* item dois")).toBe("• item um\n• item dois");
    expect(toTelegramHtml("- item um\n- item dois")).toBe("• item um\n• item dois");
    expect(toTelegramHtml("## Plano")).toBe("<b>Plano</b>");
  });

  it("treats a single star pair as italic", () => {
    expect(toTelegramHtml("*x*")).toBe("<i>x</i>");
    expect(toTelegramHtml("**x**")).toBe("<b>x</b>");
  });
});

describe("telegram text delivery", () => {
  function fakeApi(failParse: boolean): { api: TelegramBotApi; sent: Record<string, unknown>[] } {
    const sent: Record<string, unknown>[] = [];
    const base = {
      getMe: async () => ({ id: 1, username: "bot", firstName: "Bot" }),
      setWebhook: async () => undefined,
      deleteWebhook: async () => undefined,
      sendChatAction: async () => undefined,
      answerCallbackQuery: async () => undefined,
      getFile: async () => undefined,
      editMessageText: async () => undefined,
    };
    const api: TelegramBotApi = {
      ...base,
      sendMessage: async (input) => {
        if (failParse && input.parseMode !== undefined) {
          throw new Error("telegram sendMessage failed: can't parse entities");
        }
        sent.push({ text: input.text, parseMode: input.parseMode });
        return { messageId: 1, chatId: -100 };
      },
    };
    return { api, sent };
  }

  it("sends HTML and retries as plain text when the parser refuses", async () => {
    const ok = fakeApi(false);
    await sendTelegramText(ok.api, { chatId: -100, text: "`uname -r`" });
    expect(ok.sent).toEqual([{ text: "<code>uname -r</code>", parseMode: "HTML" }]);

    const bad = fakeApi(true);
    await sendTelegramText(bad.api, { chatId: -100, text: "`uname -r`" });
    expect(bad.sent).toEqual([{ text: "`uname -r`", parseMode: undefined }]);
  });
});
