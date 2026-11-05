import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { DaemonDetailBody } from "../daemons/detail-panel.js";
import type { BrowserDaemon } from "../daemons/functions.js";
import { daemonDetailPath, runDetailPath } from "../navigation/detail-paths.js";
import { RunDetailBody } from "./run-panel.js";
import type { RunDetail } from "./run-detail.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const DAEMON_ID = "22222222-2222-4222-8222-222222222222";

describe("detail links", () => {
  it("sends a recent run and an activity row to the same run, and a daemon row to that daemon", () => {
    assert.equal(runDetailPath("acme", RUN_ID), `/o/acme/activity/${RUN_ID}`);
    assert.equal(daemonDetailPath("acme", DAEMON_ID), `/o/acme/daemons/${DAEMON_ID}`);

    const home = readFileSync(new URL("../home/panel.tsx", import.meta.url), "utf8");
    const activity = readFileSync(new URL("./activity-panel.tsx", import.meta.url), "utf8");
    const daemonDetail = readFileSync(
      new URL("../daemons/detail-panel.tsx", import.meta.url),
      "utf8",
    );
    assert.match(home, /runDetailPath\(data\.organization\.slug, run\.id\)/);
    assert.match(activity, /runDetailPath\(organizationSlug, run\.id\)/);
    assert.match(home, /daemonDetailPath\(data\.organization\.slug, daemon\.id\)/);
    assert.match(home, /\$\{base\}\/daemons/);
    assert.doesNotMatch(daemonDetail, /revokeDaemon/);
  });
});

describe("run detail screen", () => {
  it("shows the stored failure and does not show a duration", () => {
    const markup = renderToStaticMarkup(<RunDetailBody detail={failedRun()} />);

    assert.match(markup, /agent_interrupted/);
    assert.match(markup, /Failed/);
    assert.equal(markup.includes("Duration"), false);
    assert.equal(markup.includes("Steps"), false);
  });

  it("shows how long a success took, the stored result, and the step that did not run", () => {
    const markup = renderToStaticMarkup(<RunDetailBody detail={succeededRun()} />);

    assert.match(markup, /Duration/);
    assert.match(markup, /2m 5s/);
    assert.match(markup, /deployed/);
    assert.match(markup, /Skipped/);
    assert.match(markup, /not reached/);
    assert.match(markup, /Steps/);
    assert.equal(markup.includes("Failure"), true);
    assert.equal(markup.includes("agent_interrupted"), false);
  });

  it("says a run is still going when it has not finished, and invents no steps", () => {
    const markup = renderToStaticMarkup(<RunDetailBody detail={runningRun()} />);

    assert.match(markup, /Still running/);
    assert.equal(markup.includes("Duration"), false);
    assert.equal(markup.includes("Steps"), false);
    assert.equal(markup.includes("agent_interrupted"), false);
  });
});

describe("daemon detail screen", () => {
  it("shows the name, the connection, and that it runs Hub automations", () => {
    const markup = renderToStaticMarkup(<DaemonDetailBody daemon={connectedDaemon()} />);

    assert.match(markup, /gio-predator-phn16-71/);
    assert.match(markup, /Connected/);
    assert.match(markup, /Hub automations/);
    assert.match(markup, new RegExp(DAEMON_ID));
    assert.equal(markup.includes("Revoke"), false);
  });

  it("says connected only when the daemon was not allowed to run automations", () => {
    const markup = renderToStaticMarkup(<DaemonDetailBody daemon={offlineDaemon()} />);

    assert.match(markup, /Connected only/);
    assert.match(markup, /Offline/);
    assert.match(markup, /paseo hub permissions grant hub\.execute/);
    assert.equal(markup.includes("Hub automations"), false);
    assert.equal(markup.includes("Revoke"), false);
  });
});

function runningRun(): RunDetail {
  return { ...failedRun(), status: "running", finishedAt: null, failureReason: null };
}

function connectedDaemon(): BrowserDaemon {
  return {
    id: DAEMON_ID,
    slug: "gio-predator-phn16-71",
    status: "active",
    presence: "connected",
    connectedAt: "2026-08-30T09:00:00.000Z",
    lastSeenAt: "2026-08-30T09:30:00.000Z",
    registeredAt: "2026-08-01T00:00:00.000Z",
    permissions: ["hub.execute"],
  };
}

function offlineDaemon(): BrowserDaemon {
  return {
    id: DAEMON_ID,
    slug: "laptop",
    status: "active",
    presence: "offline",
    connectedAt: null,
    lastSeenAt: "2026-08-30T09:30:00.000Z",
    registeredAt: "2026-08-01T00:00:00.000Z",
    permissions: [],
  };
}

function failedRun(): RunDetail {
  return {
    id: RUN_ID,
    triggerName: "pedido-deploy",
    provider: "slack",
    source: "slack.message",
    repo: null,
    status: "failed",
    receivedAt: "2026-08-30T09:30:00.000Z",
    finishedAt: "2026-08-30T09:32:05.000Z",
    duration: null,
    failureReason: "agent_interrupted",
    prompt: null,
    agent: null,
    results: [],
    outputContext: null,
    steps: [],
  };
}

function succeededRun(): RunDetail {
  return {
    id: RUN_ID,
    triggerName: "pedido-deploy",
    provider: "slack",
    source: "slack.message",
    repo: null,
    status: "succeeded",
    receivedAt: "2026-08-30T09:30:00.000Z",
    finishedAt: "2026-08-30T09:32:05.000Z",
    duration: "2m 5s",
    failureReason: null,
    prompt: "Ship it",
    agent: { provider: "codex", model: "gpt-5.4" },
    results: [{ stepId: "deploy", value: { deployed: true } }],
    outputContext: null,
    steps: [
      {
        id: "step-deploy",
        stepId: "deploy",
        ordinal: 0,
        status: "succeeded",
        startedAt: "2026-08-30T09:30:00.000Z",
        completedAt: "2026-08-30T09:32:05.000Z",
        output: { deployed: true },
        result: null,
        failureReason: null,
      },
      {
        id: "step-notice",
        stepId: "notice",
        ordinal: 1,
        status: "skipped",
        startedAt: null,
        completedAt: "2026-08-30T09:32:05.000Z",
        output: null,
        result: null,
        failureReason: "not reached",
      },
    ],
  };
}
