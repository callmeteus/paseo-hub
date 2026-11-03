import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  expandStoredSlackForwards,
  MAX_SLACK_FORWARD_DEPTH,
  readSlackMessageFiles,
  readSlackMessageText,
} from "./forwarded-message.js";

describe("readSlackMessageText", () => {
  it("reads a forward that only has Block Kit text", () => {
    const text = readSlackMessageText({
      text: "",
      attachments: [
        {
          is_msg_unfurl: true,
          author_name: "João",
          blocks: [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "Pessoal, boa tarde." }],
                },
              ],
            },
          ],
        },
      ],
    });

    assert.equal(text, "Encaminhada de João:\nPessoal, boa tarde.");
  });

  it("stops when a forward contains itself and when the chain is deeper than the cap", () => {
    const loop: Record<string, unknown> = {
      is_share: true,
      author_name: "Maria",
      text: "o problema",
      attachments: [],
    };
    loop["attachments"] = [loop];

    assert.equal(
      readSlackMessageText({ text: "", attachments: [loop] }),
      "Encaminhada de Maria:\no problema",
    );

    const text = readSlackMessageText({ text: "", attachments: [nestedShares(40)] });
    const layers = text.split("Encaminhada de A:").length - 1;
    assert.equal(layers, MAX_SLACK_FORWARD_DEPTH + 1);
  });

  it("reads a private forward from the channel the bot can open, and keeps the copy when it cannot", async () => {
    const calls: string[] = [];
    const expanded = await expandStoredSlackForwards(
      {
        lead: "",
        content: "Encaminhada de João:\nresumo",
        forwards: [{ channelId: "C0BA6DKUQJJ", messageTs: "1700000000.000020" }],
        attachments: [],
      },
      async (locator) => {
        calls.push(locator.channelId);

        if (locator.channelId === "C0BA6DKUQJJ") {
          return {
            text: "Pessoal, boa tarde.",
            attachments: [
              {
                is_share: true,
                author_name: "André",
                channel_id: "C09QAPR0VT7",
                ts: "1700000000.000010",
                text: "os títulos não foram liberados",
                files: [{ id: "F1", name: "planilha.png", mimetype: "image/png", size: 10 }],
              },
            ],
          };
        }

        return undefined;
      },
    );

    assert.equal(
      expanded.content,
      "Pessoal, boa tarde.\n\nEncaminhada de André:\nos títulos não foram liberados",
    );
    assert.deepEqual(
      expanded.files.map((file) => file.id),
      ["F1"],
    );
    assert.deepEqual(calls, ["C0BA6DKUQJJ", "C09QAPR0VT7"]);

    const closed = await expandStoredSlackForwards(
      {
        lead: "",
        content: "Encaminhada de André:\nos títulos",
        forwards: [{ channelId: "C09QAPR0VT7", messageTs: "1700000000.000010" }],
        attachments: [],
      },
      async () => undefined,
    );
    assert.equal(closed.content, "Encaminhada de André:\nos títulos");
    assert.deepEqual(closed.files, []);
  });

  it("does not collect a file that belongs to a link preview", () => {
    const files = readSlackMessageFiles({
      text: "oi",
      attachments: [
        {
          text: "preview",
          files: [{ id: "F-preview", name: "site.png" }],
        },
      ],
      files: [{ id: "F-own", name: "tela.png", size: 4 }],
    });

    assert.deepEqual(
      files.map((file) => file.id),
      ["F-own"],
    );
  });
});

/**
 * Builds a chain of forwarded messages.
 *
 * @param remaining - Layers still to add, including this one
 * @returns One Slack share attachment
 */
function nestedShares(remaining: number): Record<string, unknown> {
  const attachment: Record<string, unknown> = {
    is_share: true,
    author_name: "A",
    text: "layer",
  };

  if (remaining > 1) {
    attachment["attachments"] = [nestedShares(remaining - 1)];
  }

  return attachment;
}
