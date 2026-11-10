import type { NetworkInterfaceInfo } from "node:os";

/**
 * The origin `paseo hub login` resolves to when it is given no argument. Every other Hub has to
 * be named on the command line. Interface enumeration is skipped here: hosted Hub's machine
 * addresses are not the operator's.
 */
export const HOSTED_HUB_ORIGIN = "https://hub.paseo.sh";

export const HUB_LISTEN_KINDS = ["local", "lan", "tailscale", "netbird", "other"] as const;
export type HubListenKind = (typeof HUB_LISTEN_KINDS)[number];

export interface HubListenOrigin {
  kind: HubListenKind;
  address: string;
  origin: string;
  iface: string;
}

export interface HubListenGroup {
  kind: HubListenKind;
  label: string;
  origins: readonly HubListenOrigin[];
}

const KIND_LABELS: Record<HubListenKind, string> = {
  local: "Local",
  lan: "LAN",
  tailscale: "Tailscale",
  netbird: "Netbird",
  other: "Other",
};

/**
 * Which addresses this Hub process can be told as `paseo hub login <origin>`. Scheme and port
 * come from the page the operator is looking at; the hosts are this machine's own interfaces,
 * filtered by the process bind and by overlays that are not a path to Hub (docker bridges).
 */
export function listHubListenOrigins(input: {
  pageOrigin: string;
  bind: string;
  interfaces: NodeJS.Dict<readonly NetworkInterfaceInfo[] | undefined>;
  hostedOrigin?: string;
}): HubListenOrigin[] {
  const hosted = input.hostedOrigin ?? HOSTED_HUB_ORIGIN;
  const page = parseHttpOrigin(input.pageOrigin);
  if (page === undefined) return [];
  if (page.origin === hosted) return [];

  const found: HubListenOrigin[] = [];
  const seen = new Set<string>();
  for (const [iface, addresses] of Object.entries(input.interfaces)) {
    if (addresses === undefined) continue;
    for (const entry of addresses) {
      if (isLinkLocal(entry)) continue;
      const kind = classifyIface(iface, entry.internal);
      if (kind === "skip") continue;
      if (!bindAllows(input.bind, entry.address)) continue;
      const origin = originForAddress(page.origin, entry.address);
      if (origin === undefined || seen.has(origin)) continue;
      seen.add(origin);
      found.push({ kind, address: entry.address, origin, iface });
    }
  }
  return found.sort(compareListenOrigins);
}

export function groupListenOrigins(origins: readonly HubListenOrigin[]): HubListenGroup[] {
  return HUB_LISTEN_KINDS.flatMap((kind) => {
    const items = origins.filter((origin) => origin.kind === kind);
    if (items.length === 0) return [];
    return [{ kind, label: kindGroupLabel(kind, items), origins: items }];
  });
}

/** Prefer the address the operator already used, then IPv4 loopback, then the first group. */
export function defaultListenOrigin(
  origins: readonly HubListenOrigin[],
  pageOrigin: string | undefined,
): HubListenOrigin | undefined {
  const match = origins.find((origin) => origin.origin === pageOrigin);
  if (match !== undefined) return match;
  return (
    origins.find((origin) => origin.kind === "local" && origin.address === "127.0.0.1") ??
    origins.find((origin) => origin.kind === "local") ??
    origins[0]
  );
}

export function addressOptionLabel(
  group: readonly HubListenOrigin[],
  origin: HubListenOrigin,
): string {
  const ifaces = new Set(group.map((item) => item.iface));
  if (ifaces.size > 1) return `${otherNetworkName(origin.iface)} · ${origin.address}`;
  const v4 = group.filter((item) => !item.address.includes(":"));
  const v6 = group.filter((item) => item.address.includes(":"));
  if (v4.length === 1 && v6.length === 1) return origin.address.includes(":") ? "IPv6" : "IPv4";
  return origin.address;
}

export function originForAddress(pageOrigin: string, address: string): string | undefined {
  const page = parseHttpOrigin(pageOrigin);
  if (page === undefined) return undefined;
  const host = address.includes(":") ? `[${address}]` : address;
  const port = page.port === "" ? "" : `:${page.port}`;
  return parseHttpOrigin(`${page.protocol}//${host}${port}`)?.origin;
}

export function pageOriginFromRequest(request: Request): string | undefined {
  const origin = request.headers.get("origin");
  if (origin !== null) return parseHttpOrigin(origin)?.origin;
  const referer = request.headers.get("referer");
  if (referer === null) return undefined;
  return parseHttpOrigin(referer)?.origin;
}

export function classifyIface(name: string, internal: boolean): HubListenKind | "skip" {
  const iface = name.toLowerCase();
  if (internal || iface === "lo" || iface.startsWith("lo0")) return "local";
  if (iface.startsWith("tailscale")) return "tailscale";
  if (
    iface === "wt0" ||
    /^wt\d+$/u.test(iface) ||
    iface.startsWith("netbird") ||
    iface.startsWith("nb-")
  ) {
    return "netbird";
  }
  if (isSkippedVirtual(iface)) return "skip";
  if (isOtherOverlay(iface)) return "other";
  return "lan";
}

function kindGroupLabel(kind: HubListenKind, origins: readonly HubListenOrigin[]): string {
  if (kind !== "other") return KIND_LABELS[kind];
  const names = new Set(origins.map((origin) => otherNetworkName(origin.iface)));
  if (names.size === 1) {
    const [name] = names;
    if (name !== undefined) return name;
  }
  return KIND_LABELS.other;
}

function otherNetworkName(iface: string): string {
  const name = iface.toLowerCase();
  if (/^wg\d+$/u.test(name) || name.startsWith("wireguard")) return "WireGuard";
  if (name.startsWith("zt")) return "ZeroTier";
  if (name.includes("cloudflare") || name.startsWith("cfwarp")) return "WARP";
  if (name.startsWith("ham")) return "Hamachi";
  if (name.startsWith("nebula")) return "Nebula";
  if (/^(?:tun|tap|utun)\d+$/u.test(name)) return "VPN";
  return iface;
}

function isSkippedVirtual(iface: string): boolean {
  return (
    iface === "docker0" ||
    iface.startsWith("docker") ||
    iface.startsWith("br-") ||
    iface.startsWith("veth") ||
    iface.startsWith("cni") ||
    iface.startsWith("flannel") ||
    iface.startsWith("calico") ||
    iface.startsWith("weave") ||
    iface.startsWith("kube") ||
    iface.startsWith("lxc") ||
    iface.startsWith("virbr") ||
    iface.startsWith("vmnet") ||
    iface.startsWith("vboxnet")
  );
}

function isOtherOverlay(iface: string): boolean {
  return (
    /^wg\d+$/u.test(iface) ||
    iface.startsWith("wireguard") ||
    iface.startsWith("zt") ||
    iface.includes("cloudflare") ||
    iface.startsWith("cfwarp") ||
    iface.startsWith("ham") ||
    iface.startsWith("nebula") ||
    /^(?:tun|tap|utun)\d+$/u.test(iface)
  );
}

function bindAllows(bind: string, address: string): boolean {
  const ipv6 = address.includes(":");
  if (bind === "0.0.0.0" || bind === "") return !ipv6;
  if (bind === "::" || bind === "*") return true;
  return bind === address;
}

function isLinkLocal(entry: NetworkInterfaceInfo): boolean {
  if (isIPv6(entry)) {
    const address = entry.address.toLowerCase();
    return address.startsWith("fe80:") || address.startsWith("::ffff:");
  }
  return entry.address.startsWith("169.254.");
}

function isIPv6(entry: NetworkInterfaceInfo): boolean {
  return entry.family === "IPv6";
}

function parseHttpOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function compareListenOrigins(left: HubListenOrigin, right: HubListenOrigin): number {
  const kind = HUB_LISTEN_KINDS.indexOf(left.kind) - HUB_LISTEN_KINDS.indexOf(right.kind);
  if (kind !== 0) return kind;
  const leftV6 = left.address.includes(":") ? 1 : 0;
  const rightV6 = right.address.includes(":") ? 1 : 0;
  if (leftV6 !== rightV6) return leftV6 - rightV6;
  return left.address.localeCompare(right.address);
}
