import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { checkOutboundText, extractLocalAttachments, sanitizeOutboundText } from "./outbound.js";

describe("Slack outbound text check with no locale", () => {
  it("accepts an English multi-paragraph reply", () => {
    const result = checkOutboundText(
      "I'll start by reading the thread and then I will post the answer.\n\n" +
        "The deploy failed because the backend cache ran out of memory.\n\n" +
        "I ran it again and the container came up with the new worker version.\n\n" +
        "Let me know if you want the logs.",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("accepts a reply longer than the limit", () => {
    const result = checkOutboundText(`Aviso: ${"x".repeat(1200)}`);
    assert.deepEqual(result, { ok: true });
  });

  it("accepts more than three paragraphs", () => {
    const result = checkOutboundText(
      "Primeiro parágrafo.\n\nSegundo parágrafo.\n\nTerceiro parágrafo.\n\nQuarto parágrafo.",
    );
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

  it("rejects a raw Slack user id written as plain text", () => {
    const result = checkOutboundText(
      "Confirmei no banco do E7 que o Gio (U094VQCSK53) está no time ativo SRE/DevOps.",
    );
    assert.equal(result.ok, false);
    assert.match(reason(result), /U094VQCSK53/u);
    assert.match(reason(result), /<@U094VQCSK53>/u);
  });

  it("rejects a link to a file outside the local attachment directory", () => {
    const result = checkOutboundText("Veja <file:///home/gio/prints/a.png|Print>.");
    assert.equal(result.ok, false);
    assert.match(reason(result), /file:\/\/\/home\/gio\/prints\/a\.png/u);
  });

  it("accepts a real Slack mention", () => {
    const result = checkOutboundText("Beleza <@U094VQCSK53>, já ajustei a rotina.");
    assert.deepEqual(result, { ok: true });
  });

  it("accepts a link inside the local attachment directory", () => {
    const result = checkOutboundText(
      "Segue o gráfico: <file:///tmp/paseo-attachments-ab12/hash.png|Image>",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("rejects an invalid mention in an English reply too", () => {
    const result = checkOutboundText("Beleza <@phone-home>, I already fixed the routine.");
    assert.equal(result.ok, false);
    assert.match(reason(result), /<@phone-home>/u);
  });
});

describe("Slack outbound text check with pt-BR", () => {
  it("rejects narration in English the model writes about itself", () => {
    const result = checkOutboundText(
      "I'll start by reacting to the message and reading the thread context.",
      "pt-BR",
    );
    assert.equal(result.ok, false);
    assert.match(reason(result), /português/u);
  });

  it("rejects a Portuguese summary of the execution", () => {
    const result = checkOutboundText(
      "Respondi na thread: o aviso é da cobrança, não do envio.",
      "pt-BR",
    );
    assert.equal(result.ok, false);
    assert.match(reason(result), /não narre a execução com "respondi na thread"/iu);
  });

  it("rejects what the execution did instead of answering", () => {
    const result = checkOutboundText("O que fiz nesta execução: rodei os testes.", "pt-BR");
    assert.equal(result.ok, false);
  });

  it("rejects a summary of the execution in the middle of the reply", () => {
    const result = checkOutboundText(
      "Ajuste lançado.\n\n" +
        "O que fiz nesta execução:\n" +
        "• Confirmei no banco que o Gio está no time ativo SRE/DevOps.\n" +
        "• Reli o saldo.\n\n" +
        "Uma observação técnica: LAST_INSERT_ID() via CLI voltou 0.",
      "pt-BR",
    );
    assert.equal(result.ok, false);
    assert.match(reason(result), /o que fiz/iu);
  });

  it("rejects a bullet line that narrates the execution", () => {
    const result = checkOutboundText(
      "O ajuste já está no ar.\n\n• Nesta execução eu rodei os testes e conferi o saldo.",
      "pt-BR",
    );
    assert.equal(result.ok, false);
  });

  it("rejects a reply written in English without narration markers", () => {
    const result = checkOutboundText(
      "The deploy failed because the backend cache ran out of memory.",
      "pt-BR",
    );
    assert.equal(result.ok, false);
    assert.match(reason(result), /português/u);
  });

  it("accepts a normal Portuguese reply with technical words", () => {
    const result = checkOutboundText(
      "O deploy falhou porque o cache do backend ficou sem memória.\n\n" +
        "Já rodei de novo e o container subiu com a versão nova do worker.",
      "pt-BR",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("accepts a Portuguese reply that only talks about a closed thread", () => {
    const result = checkOutboundText(
      "A cobrança foi gerada de novo e o aviso saiu certo.\n\nPode conferir na fatura.",
      "pt-BR",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("does not count the paragraphs inside a code block", () => {
    const result = checkOutboundText(
      "Corrigi a query.\n\n```\nselect 1;\n\nselect 2;\n\nselect 3;\n```\n\nPode rodar.",
      "pt-BR",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("does not read the language of code or of a URL", () => {
    const result = checkOutboundText(
      "O erro que voltou foi este: `failed to connect to the database server`.\n\n" +
        "Veja também https://example.com/the/thing/that/happened for more of it.",
      "pt-BR",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("rejects more than three paragraphs", () => {
    const result = checkOutboundText(
      "Primeiro parágrafo.\n\nSegundo parágrafo.\n\nTerceiro parágrafo.\n\nQuarto parágrafo.",
      "pt-BR",
    );
    assert.equal(result.ok, false);
    assert.match(reason(result), /4 parágrafos/u);
  });

  it("rejects a reply longer than 1200 characters", () => {
    const result = checkOutboundText(`Aviso: ${"x".repeat(1200)}`, "pt-BR");
    assert.equal(result.ok, false);
    assert.match(reason(result), /1207 caracteres/u);
  });

  it("keeps the always-on checks", () => {
    assert.equal(
      checkOutboundText("Beleza <@phone-home>, já ajustei a rotina.", "pt-BR").ok,
      false,
    );
    assert.equal(checkOutboundText("Veja <file:///home/gio/a.png|Print>.", "pt-BR").ok, false);
    assert.equal(checkOutboundText("O time do Gio (U094VQCSK53) está ativo.", "pt-BR").ok, false);
  });
});

describe("Slack outbound text check with en", () => {
  it("accepts an English reply", () => {
    assert.deepEqual(checkOutboundText("The deploy is up and the tests pass.", "en"), { ok: true });
  });

  it("skips the language check for an English locale", () => {
    const result = checkOutboundText("O ajuste já está no ar e o saldo confere.", "en");
    assert.deepEqual(result, { ok: true });
  });

  it("rejects English narration", () => {
    const result = checkOutboundText("I'll start by reading the thread.", "en");
    assert.equal(result.ok, false);
    assert.match(reason(result), /narrate the execution/iu);
  });

  it("rejects a reply over the limits", () => {
    assert.equal(checkOutboundText(`Notice: ${"x".repeat(1200)}`, "en").ok, false);
    assert.equal(checkOutboundText("One.\n\nTwo.\n\nThree.\n\nFour.", "en").ok, false);
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
