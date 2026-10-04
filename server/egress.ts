import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup as dnsLookupAll } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Loopback, private, link-local, shared (CGNAT), documentation, benchmarking, multicast and reserved ranges.
const nonPublic = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublic.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 127], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) nonPublic.addSubnet(network, prefix, "ipv6");

export class BlockedDestinationError extends Error {
  readonly code = "EBLOCKEDDESTINATION";
  constructor(hostname: string) {
    super(`${hostname} is not a public internet address`);
    this.name = "BlockedDestinationError";
  }
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address, "ipv4");
  if (family !== 6) return false;
  const embedded = embeddedIpv4(address);
  if (embedded) return isPublicAddress(embedded);
  return !nonPublic.check(address, "ipv6");
}

/** URL.hostname keeps the brackets of IPv6 literals; DNS and address checks need them removed. */
export function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/u, "$1").toLocaleLowerCase("en-US");
}

/** Rejects URLs that are not HTTP(S) or whose host resolves to a non-public address. */
export async function assertPublicHttpUrl(value: string | URL): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported URL scheme ${url.protocol}`);
  const hostname = bareHostname(url);
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new BlockedDestinationError(hostname);
    return;
  }
  const addresses = await dnsLookupAll(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new BlockedDestinationError(hostname);
  }
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A dns.lookup replacement for sockets that may only reach public addresses. Checking at
 * connection time means a second DNS answer cannot swap in a private address (DNS rebinding).
 * IP literals never reach a lookup function, so callers must also check them with assertPublicHttpUrl.
 */
export function publicOnlyLookup(hostname: string, options: LookupOptions | number | LookupCallback, callback?: LookupCallback): void {
  const done = (typeof options === "function" ? options : callback)!;
  const requested: LookupOptions = typeof options === "number" ? { family: options } : typeof options === "function" ? {} : options;
  dnsLookup(hostname, { ...requested, all: true }, (error, addresses) => {
    if (error) return done(error, []);
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      return done(new BlockedDestinationError(hostname), []);
    }
    if (requested.all) return done(null, addresses);
    done(null, addresses[0].address, addresses[0].family);
  });
}

function embeddedIpv4(address: string): string | undefined {
  const bytes = ipv6Bytes(address);
  if (!bytes) return undefined;
  const leadingZeros = (count: number) => bytes.slice(0, count).every((value) => value === 0);
  const ipv4 = (offset: number) => bytes.slice(offset, offset + 4).join(".");
  // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d and 6to4 2002:aabb:ccdd::.
  if (leadingZeros(10) && bytes[10] === 0xff && bytes[11] === 0xff) return ipv4(12);
  if (leadingZeros(12) && (bytes[12] !== 0 || bytes[13] !== 0)) return ipv4(12);
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((value) => value === 0)) return ipv4(12);
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return ipv4(2);
  return undefined;
}

function ipv6Bytes(address: string): number[] | undefined {
  let value = address.toLocaleLowerCase("en-US").split("%", 1)[0];
  const dotted = value.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/u);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    value = `${value.slice(0, -dotted[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const compressed = value.includes("::");
  const [head, tail = ""] = value.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = compressed && tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (compressed ? missing < 1 : headGroups.length !== 8) return undefined;
  const groups = [...headGroups, ...Array<string>(compressed ? missing : 0).fill("0"), ...tailGroups].map((group) => Number.parseInt(group, 16));
  if (groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return undefined;
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}
