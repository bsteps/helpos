import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "./address.ts";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // AWS/GCP/Azure metadata
    "100.100.100.200", // Alibaba metadata (CGNAT range)
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00:ec2::254", // AWS IPv6 metadata
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1", // same, hex notation
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe", // NAT64 to metadata
    "2002:7f00:1::", // 6to4 to loopback
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "[::1]",
    "not-an-ip",
    "",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows public %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});
