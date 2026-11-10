import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, it } from "vitest";
import {
  addressOptionLabel,
  classifyIface,
  defaultListenOrigin,
  groupListenOrigins,
  HOSTED_HUB_ORIGIN,
  listHubListenOrigins,
  originForAddress,
  pageOriginFromRequest,
  type HubListenOrigin,
} from "./listen-origins.js";

const PAGE = "http://127.0.0.1:25000";

function addr(address: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo {
  if (family === "IPv6") {
    return {
      address,
      netmask: "ffff:ffff:ffff:ffff::",
      family,
      mac: "00:00:00:00:00:00",
      internal,
      cidr: null,
      scopeid: 0,
    };
  }
  return {
    address,
    netmask: "255.255.255.0",
    family,
    mac: "00:00:00:00:00:00",
    internal,
    cidr: null,
  };
}

const THIS_MACHINE: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo: [addr("127.0.0.1", "IPv4", true), addr("::1", "IPv6", true)],
  wlp0s20f3: [addr("192.168.0.243", "IPv4"), addr("fe80::7a0b:5080:8de2:8946", "IPv6")],
  docker0: [addr("172.17.0.1", "IPv4")],
  "br-3323c306649a": [addr("172.25.0.1", "IPv4")],
  vethcb78b48: [addr("fe80::f41c:7ff:fefc:b538", "IPv6")],
  wt0: [addr("100.89.201.14", "IPv4"), addr("fd23:8af6:5219:487f:374f:1756:7ba9:6433", "IPv6")],
  tailscale0: [
    addr("100.66.222.98", "IPv4"),
    addr("fd7a:115c:a1e0::5d3b:de65", "IPv6"),
    addr("fe80::d59e:3115:612e:92f7", "IPv6"),
  ],
  wg0: [addr("10.147.18.11", "IPv4")],
};

describe("interface classification", () => {
  it("names the overlays this machine actually has, and skips docker", () => {
    assert.equal(classifyIface("lo", true), "local");
    assert.equal(classifyIface("wlp0s20f3", false), "lan");
    assert.equal(classifyIface("enp109s0", false), "lan");
    assert.equal(classifyIface("tailscale0", false), "tailscale");
    assert.equal(classifyIface("wt0", false), "netbird");
    assert.equal(classifyIface("netbird0", false), "netbird");
    assert.equal(classifyIface("wg0", false), "other");
    assert.equal(classifyIface("docker0", false), "skip");
    assert.equal(classifyIface("br-3323c306649a", false), "skip");
    assert.equal(classifyIface("vethcb78b48", false), "skip");
  });

  it("does not treat wifi (wlp) as Netbird (wt)", () => {
    assert.equal(classifyIface("wlp0s20f3", false), "lan");
  });
});

describe("listing listen origins", () => {
  it("keeps local, LAN, Tailscale, Netbird, and WireGuard, and drops docker and link-local", () => {
    const origins = listHubListenOrigins({
      pageOrigin: PAGE,
      bind: "0.0.0.0",
      interfaces: THIS_MACHINE,
    });
    const byKind = addressesByKind(origins);

    assert.deepEqual(byKind, {
      local: ["127.0.0.1"],
      lan: ["192.168.0.243"],
      tailscale: ["100.66.222.98"],
      netbird: ["100.89.201.14"],
      other: ["10.147.18.11"],
    });
    assert.equal(
      origins.find((origin) => origin.address === "100.66.222.98")?.origin,
      "http://100.66.222.98:25000",
    );
    assert.equal(
      origins.find((origin) => origin.address === "fd7a:115c:a1e0::5d3b:de65"),
      undefined,
    );
  });

  it("includes IPv6 when Hub bound itself to ::", () => {
    const origins = listHubListenOrigins({
      pageOrigin: PAGE,
      bind: "::",
      interfaces: THIS_MACHINE,
    });
    assert.ok(origins.some((origin) => origin.address === "fd7a:115c:a1e0::5d3b:de65"));
    assert.equal(
      origins.find((origin) => origin.address === "fd7a:115c:a1e0::5d3b:de65")?.origin,
      "http://[fd7a:115c:a1e0::5d3b:de65]:25000",
    );
  });

  it("names a lone other overlay after the network, not Other", () => {
    const origins = listHubListenOrigins({
      pageOrigin: PAGE,
      bind: "0.0.0.0",
      interfaces: THIS_MACHINE,
    });
    const other = groupListenOrigins(origins).find((group) => group.kind === "other");
    assert.equal(other?.label, "WireGuard");
  });

  it("only lists the address Hub bound itself to", () => {
    const origins = listHubListenOrigins({
      pageOrigin: PAGE,
      bind: "127.0.0.1",
      interfaces: THIS_MACHINE,
    });
    assert.deepEqual(
      origins.map((origin) => origin.address),
      ["127.0.0.1"],
    );
  });

  it("does not enumerate hosted Hub's machine addresses", () => {
    assert.deepEqual(
      listHubListenOrigins({
        pageOrigin: HOSTED_HUB_ORIGIN,
        bind: "0.0.0.0",
        interfaces: THIS_MACHINE,
      }),
      [],
    );
  });

  it("returns nothing for a page origin that is not http", () => {
    assert.deepEqual(
      listHubListenOrigins({
        pageOrigin: "ftp://127.0.0.1:25000",
        bind: "0.0.0.0",
        interfaces: THIS_MACHINE,
      }),
      [],
    );
  });
});

describe("picking a default origin", () => {
  it("keeps the address the operator already opened, otherwise IPv4 loopback", () => {
    const origins = listHubListenOrigins({
      pageOrigin: "http://100.66.222.98:25000",
      bind: "0.0.0.0",
      interfaces: THIS_MACHINE,
    });
    assert.equal(
      defaultListenOrigin(origins, "http://100.66.222.98:25000")?.address,
      "100.66.222.98",
    );
    assert.equal(defaultListenOrigin(origins, PAGE)?.address, "127.0.0.1");
    assert.equal(defaultListenOrigin(origins, undefined)?.address, "127.0.0.1");
  });
});

describe("address labels inside a kind", () => {
  it("says IPv4/IPv6 when a kind has one of each, and names the iface when several overlays share Other", () => {
    const tailscale: HubListenOrigin[] = [
      {
        kind: "tailscale",
        address: "100.66.222.98",
        origin: "http://100.66.222.98:25000",
        iface: "tailscale0",
      },
      {
        kind: "tailscale",
        address: "fd7a:115c:a1e0::5d3b:de65",
        origin: "http://[fd7a:115c:a1e0::5d3b:de65]:25000",
        iface: "tailscale0",
      },
    ];
    assert.equal(addressOptionLabel(tailscale, tailscale[0]!), "IPv4");
    assert.equal(addressOptionLabel(tailscale, tailscale[1]!), "IPv6");

    const mixed: HubListenOrigin[] = [
      {
        kind: "other",
        address: "10.147.18.11",
        origin: "http://10.147.18.11:25000",
        iface: "wg0",
      },
      {
        kind: "other",
        address: "10.147.0.2",
        origin: "http://10.147.0.2:25000",
        iface: "zt0",
      },
    ];
    assert.equal(addressOptionLabel(mixed, mixed[0]!), "WireGuard · 10.147.18.11");
    assert.equal(addressOptionLabel(mixed, mixed[1]!), "ZeroTier · 10.147.0.2");
  });
});

describe("origin rewriting", () => {
  it("keeps scheme and port, and brackets IPv6", () => {
    assert.equal(originForAddress(PAGE, "192.168.0.243"), "http://192.168.0.243:25000");
    assert.equal(
      originForAddress("https://hub.example.com", "100.66.222.98"),
      "https://100.66.222.98",
    );
    assert.equal(
      originForAddress("https://hub.example.com:8443", "fd7a:115c:a1e0::5d3b:de65"),
      "https://[fd7a:115c:a1e0::5d3b:de65]:8443",
    );
  });
});

function addressesByKind(origins: readonly HubListenOrigin[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const group of groupListenOrigins(origins)) {
    grouped[group.kind] = group.origins.map((origin) => origin.address);
  }
  return grouped;
}

describe("the origin the browser used to call Hub", () => {
  it("prefers Origin, then Referer", () => {
    assert.equal(
      pageOriginFromRequest(
        new Request("http://hub.internal/_server", { headers: { origin: PAGE } }),
      ),
      PAGE,
    );
    assert.equal(
      pageOriginFromRequest(
        new Request("http://hub.internal/_server", {
          headers: { referer: `${PAGE}/o/acme/daemons` },
        }),
      ),
      PAGE,
    );
    assert.equal(pageOriginFromRequest(new Request("http://hub.internal/_server")), undefined);
  });
});
