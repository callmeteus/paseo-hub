/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop -- each case renders one static tree */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { formatAbsolute } from "../components/app/relative-time.js";
import { UnroutedEventList } from "./unrouted-events.js";

const RECEIVED_AT = "2026-09-21T09:00:00.000Z";
const event = {
  id: "event-1",
  provider: "slack" as const,
  source: "slack.mention",
  receivedAt: RECEIVED_AT,
  channel: "alertas",
  author: "gio",
  text: "@plantao ⚠️ @gio check the channel...",
  body: `@plantao ⚠️ @gio\ncheck the channel ${"x".repeat(40)}TAILMARKER`,
};

describe("events with no trigger", () => {
  it("keeps the row to one line until it is opened", () => {
    const closed = render(null);
    const open = render(event.id);

    assert.match(closed, /<button[^>]*type="button"[^>]*aria-expanded="false"/u);
    assert.match(closed, /@plantao/u);
    assert.match(closed, /alertas/u);
    assert.match(closed, /gio/u);
    assert.match(closed, /Slack/u);
    assert.doesNotMatch(closed, /TAILMARKER/u);
    assert.doesNotMatch(closed, /bg-accent|bg-muted|bg-card/u);

    const clock = new RegExp(`>${escapeRegExp(formatAbsolute(RECEIVED_AT))}<`, "u");
    assert.match(open, /aria-expanded="true"/u);
    assert.match(open, /TAILMARKER/u);
    assert.match(open, clock);
    assert.doesNotMatch(closed, clock);
    assert.match(open, /id="unrouted-event-event-1"/u);
    assert.doesNotMatch(open, /bg-accent|bg-muted|bg-card/u);
  });
});

function render(openId: string | null): string {
  return renderToStaticMarkup(
    <UnroutedEventList events={[event]} openId={openId} onOpen={() => undefined} />,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
