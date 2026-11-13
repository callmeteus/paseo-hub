import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ANY_DAEMON, daemonAffinityLabel, pickDispatchDaemon } from "./any-daemon.js";

const daemon = (
  slug: string,
  presence: "connected" | "offline",
  permissions: string[] = ["hub.execute"],
) => ({
  id: `id-${slug}`,
  slug,
  status: "active" as const,
  presence,
  permissions,
});

describe("pickDispatchDaemon", () => {
  it("picks the first connected daemon that can execute", () => {
    assert.deepEqual(
      pickDispatchDaemon([
        daemon("zeta", "connected"),
        daemon("offline", "offline"),
        daemon("alpha", "connected"),
        daemon("blocked", "connected", []),
      ]),
      { id: "id-alpha", slug: "alpha" },
    );
  });

  it("skips a connected daemon the socket cannot dispatch to", () => {
    assert.deepEqual(
      pickDispatchDaemon(
        [daemon("alpha", "connected"), daemon("zeta", "connected")],
        (id) => id === "id-zeta",
      ),
      { id: "id-zeta", slug: "zeta" },
    );
  });

  it("waits when nothing is connected", () => {
    assert.equal(pickDispatchDaemon([daemon("alpha", "offline")]), undefined);
  });
});

describe("daemonAffinityLabel", () => {
  it("names the unpinned target Any", () => {
    assert.equal(daemonAffinityLabel(ANY_DAEMON), "Any");
    assert.equal(daemonAffinityLabel("gio-predator-phn16-71"), "gio-predator-phn16-71");
  });
});
