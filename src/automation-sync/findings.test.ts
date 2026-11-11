import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { FINDING_EVIDENCE_MESSAGE, formatFindings, parseFinding } from "./findings.js";

describe("organization findings", () => {
  it("rejects a finding that has no Slack reply or tool call", () => {
    assert.throws(
      () =>
        parseFinding({ statement: "O bot errou.", replies: [], tool: { name: "x", result: "y" } }),
      new RegExp(FINDING_EVIDENCE_MESSAGE),
    );
    assert.throws(
      () => parseFinding({ statement: "O bot errou.", replies: ["uma resposta"] }),
      new RegExp(FINDING_EVIDENCE_MESSAGE),
    );
  });

  it("stores the fact with both pieces of evidence and finds it later", async () => {
    const database = createMemoryDatabase();
    const saved = await database.insertOrganizationFinding({
      organizationId: "org",
      ...parseFinding({
        statement: "O bot de triagem disse que o envio é do E7 Engage.",
        replies: ["o envio é do E7 Engage"],
        tool: { name: "slack_read", result: "mensagem citada" },
      }),
    });
    const found = await database.searchOrganizationFindings("org", "engage");
    assert.deepEqual(found, [saved]);
    assert.match(formatFindings(found), /E7 Engage/);
    assert.match(formatFindings(found), /slack_read/);
    assert.match(formatFindings(found), /mensagem citada/);
    assert.deepEqual(await database.searchOrganizationFindings("other", "engage"), []);
  });

  it("keeps a thumb out of the findings search", async () => {
    const database = createMemoryDatabase();
    await database.insertOrganizationResponseFeedback({
      organizationId: "org",
      teamId: "T1",
      channelId: "C1",
      messageTs: "1.1",
      rating: "negative",
      comment: "the answer missed the date",
    });
    assert.deepEqual(await database.searchOrganizationFindings("org", "date"), []);
    const feedback = await database.searchOrganizationResponseFeedback("org", "date");
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0]?.rating, "negative");
    assert.equal(feedback[0]?.channelId, "C1");
    assert.equal(feedback[0]?.messageTs, "1.1");
  });
});
