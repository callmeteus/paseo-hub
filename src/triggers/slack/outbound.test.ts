import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { checkOutboundText, extractLocalAttachments, sanitizeOutboundText } from "./outbound.js";

describe("Slack outbound text check", () => {
  it("rejects narration in English the model writes about itself", () => {
    const result = checkOutboundText(
      "I'll start by reacting to the message and reading the thread context.",
    );
    assert.equal(result.ok, false);
    assert.match(reason(result), /português/u);
  });

  it("rejects a Portuguese summary of the execution", () => {
    const result = checkOutboundText("Respondi na thread: o aviso é da cobrança, não do envio.");
    assert.equal(result.ok, false);
    assert.match(reason(result), /não abra com "respondi na thread"/iu);
  });

  it("rejects what the execution did instead of answering", () => {
    const result = checkOutboundText("O que fiz nesta execução: rodei os testes.");
    assert.equal(result.ok, false);
  });

  it("accepts Portuguese with a few English tech words", () => {
    const result = checkOutboundText(
      "O deploy falhou porque o cache do backend ficou sem memória.\n\n" +
        "Já rodei de novo e o container subiu com a versão nova do worker.",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("accepts a real Slack mention", () => {
    const result = checkOutboundText("Beleza <@U094VQCSK53>, já ajustei a rotina.");
    assert.deepEqual(result, { ok: true });
  });

  it("rejects a mention that is not a Slack id", () => {
    const result = checkOutboundText("Beleza <@phone-home>, já ajustei a rotina.");
    assert.equal(result.ok, false);
    assert.match(reason(result), /<@phone-home>/u);
  });

  it("rejects a labelled mention whose id is not a Slack id", () => {
    const result = checkOutboundText("Beleza <@phone-home|Telefone>, já ajustei.");
    assert.equal(result.ok, false);
  });

  it("rejects a link to a file outside the local attachment directory", () => {
    const result = checkOutboundText("Veja <file:///home/gio/prints/a.png|Print>.");
    assert.equal(result.ok, false);
    assert.match(reason(result), /file:\/\/\/home\/gio\/prints\/a\.png/u);
  });

  it("accepts a link inside the local attachment directory", () => {
    const result = checkOutboundText(
      "Segue o gráfico: <file:///tmp/paseo-attachments-ab12/hash.png|Image>",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("rejects more than three paragraphs", () => {
    const result = checkOutboundText(
      "Primeiro parágrafo.\n\nSegundo parágrafo.\n\nTerceiro parágrafo.\n\nQuarto parágrafo.",
    );
    assert.equal(result.ok, false);
    assert.match(reason(result), /4 parágrafos/u);
  });

  it("does not count the paragraphs inside a code block", () => {
    const result = checkOutboundText(
      "Corrigi a query.\n\n```\nselect 1;\n\nselect 2;\n\nselect 3;\n```\n\nPode rodar.",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("rejects a reply longer than 1200 characters", () => {
    const result = checkOutboundText(`Aviso: ${"x".repeat(1200)}`);
    assert.equal(result.ok, false);
    assert.match(reason(result), /1207 caracteres/u);
  });

  it("does not read the language of code or of a URL", () => {
    const result = checkOutboundText(
      "O erro que voltou foi este: `failed to connect to the database server`.\n\n" +
        "Veja também https://example.com/the/thing/that/happened for more of it.",
    );
    assert.deepEqual(result, { ok: true });
  });
});

describe("Slack outbound text sanitize", () => {
  it("writes an invalid mention as its label", () => {
    assert.equal(
      sanitizeOutboundText("Beleza <@phone-home|Telefone>, já ajustei."),
      "Beleza Telefone, já ajustei.",
    );
  });

  it("writes an invalid mention as its plain id", () => {
    assert.equal(sanitizeOutboundText("Beleza <@phone-home>."), "Beleza phone-home.");
  });

  it("leaves a real Slack mention alone", () => {
    assert.equal(sanitizeOutboundText("Beleza <@U094VQCSK53|Gio>."), "Beleza <@U094VQCSK53|Gio>.");
  });

  it("leaves a link and the rest of the text alone", () => {
    assert.equal(
      sanitizeOutboundText("Execução falhou: <file:///tmp/paseo-attachments-ab12/hash.png|Image>"),
      "Execução falhou: <file:///tmp/paseo-attachments-ab12/hash.png|Image>",
    );
  });
});

describe("Slack outbound local attachments", () => {
  it("takes the Slack file link out of the text", () => {
    const extracted = extractLocalAttachments(
      "Segue o gráfico:\n<file:///tmp/paseo-attachments-x/a.png|Image>\n\nAbraço.",
    );
    assert.deepEqual(extracted.files, ["/tmp/paseo-attachments-x/a.png"]);
    assert.equal(extracted.text, "Segue o gráfico:\n\nAbraço.");
  });

  it("takes a markdown image out of the text", () => {
    const extracted = extractLocalAttachments(
      "Gráfico ![Gráfico](file:///tmp/paseo-attachments-x/a.png) pronto.",
    );
    assert.deepEqual(extracted.files, ["/tmp/paseo-attachments-x/a.png"]);
    assert.equal(extracted.text, "Gráfico pronto.");
  });

  it("keeps a remote link in the text", () => {
    const extracted = extractLocalAttachments("Veja https://example.com/a.png por favor.");
    assert.deepEqual(extracted.files, []);
    assert.equal(extracted.text, "Veja https://example.com/a.png por favor.");
  });

  it("leaves text that has no file link alone", () => {
    const extracted = extractLocalAttachments("Tudo certo por aqui.");
    assert.deepEqual(extracted, { text: "Tudo certo por aqui.", files: [] });
  });
});

function reason(result: ReturnType<typeof checkOutboundText>): string {
  assert.equal(result.ok, false);
  return result.ok ? "" : result.reason;
}
