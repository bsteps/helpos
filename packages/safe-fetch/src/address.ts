import { BlockList, isIPv4, isIPv6 } from "node:net";

// Anything that is not a plain public unicast address. Cloud metadata endpoints
// (169.254.169.254, fd00:ec2::254) fall inside link-local and unique-local.
const v4Blocked: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

const v6Blocked: [string, number][] = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::", 96], // IPv4-compatible (deprecated), would reach an IPv4 host
  ["64:ff9b::", 96], // NAT64, would reach an IPv4 host
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo, embeds an IPv4 address
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, embeds an IPv4 address
  ["fc00::", 7], // unique local, includes fd00:ec2::254 metadata
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

const blocked = new BlockList();
for (const [net, prefix] of v4Blocked) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of v6Blocked) blocked.addSubnet(net, prefix, "ipv6");

const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;
const mappedV4Hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/** Unwraps `::ffff:a.b.c.d` (in either notation) so it is judged as the IPv4 host it reaches. */
function unmapV4(address: string): string | null {
  const dotted = mappedV4.exec(address);
  if (dotted?.[1]) return dotted[1];
  const hex = mappedV4Hex.exec(address);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True when the address must never be fetched. Unparseable input counts as blocked. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  if (isIPv4(bare)) return blocked.check(bare, "ipv4");
  if (isIPv6(bare)) {
    const v4 = unmapV4(bare);
    if (v4 !== null) return isBlockedAddress(v4);
    return blocked.check(bare, "ipv6");
  }
  return true;
}
