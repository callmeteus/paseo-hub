import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { AddDaemonInstructions } from "./account-daemons.js";
import { CONNECT_COMMAND, daemonLoginCommand } from "./handoff.js";
import type { HubListenOrigin } from "./listen-origins.js";

const PAGE = "http://127.0.0.1:25000";
const ORIGINS: readonly HubListenOrigin[] = [
  { kind: "local", address: "127.0.0.1", origin: PAGE, iface: "lo" },
  {
    kind: "lan",
    address: "192.168.0.243",
    origin: "http://192.168.0.243:25000",
    iface: "wlp0s20f3",
  },
  {
    kind: "tailscale",
    address: "100.66.222.98",
    origin: "http://100.66.222.98:25000",
    iface: "tailscale0",
  },
  {
    kind: "netbird",
    address: "100.89.201.14",
    origin: "http://100.89.201.14:25000",
    iface: "wt0",
  },
  {
    kind: "other",
    address: "10.147.18.11",
    origin: "http://10.147.18.11:25000",
    iface: "wg0",
  },
];

describe("add daemon instructions", () => {
  it("names this Hub in the login command and offers connect for a machine already logged in", () => {
    const origin = "https://hub.internal.example:8443";
    const screen = renderToStaticMarkup(<AddDaemonInstructions pageOrigin={origin} />);

    assert.ok(screen.includes(daemonLoginCommand(origin)));
    assert.ok(screen.includes(CONNECT_COMMAND));
    assert.match(screen, /Login command/u);
    assert.match(screen, /Already logged in/u);
    assert.match(screen, /How to connect a daemon/u);
    assert.match(screen, /href="https:\/\/paseo\.sh\/docs\/hub\/daemons"/u);
    assert.doesNotMatch(screen, /aria-label="Network"/u);
  });

  it("keeps connect when the page origin is not known yet", () => {
    const screen = renderToStaticMarkup(<AddDaemonInstructions />);

    assert.ok(!screen.includes("paseo hub login"));
    assert.ok(screen.includes(CONNECT_COMMAND));
  });

  it("offers a tab for each network this Hub is reachable on", () => {
    const screen = renderToStaticMarkup(
      <AddDaemonInstructions pageOrigin={PAGE} origins={ORIGINS} />,
    );

    assert.match(screen, /aria-label="Network"/u);
    assert.match(screen, />Local</u);
    assert.match(screen, />LAN</u);
    assert.match(screen, />Tailscale</u);
    assert.match(screen, />Netbird</u);
    assert.match(screen, />WireGuard</u);
    assert.ok(screen.includes(daemonLoginCommand(PAGE)));
  });
});
