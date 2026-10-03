import { describe, expect, it } from "vitest";
import { detectLanIp } from "../src/server/lan-ip.js";

const a = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: null });

describe("detectLanIp", () => {
  it("skips loopback, docker and vpn interfaces and picks the private LAN address", () => {
    expect(detectLanIp({ lo: [a("127.0.0.1", true)], docker0: [a("172.17.0.1")], tailscale0: [a("100.64.1.2")], eno1: [a("192.168.50.50")] })).toBe("192.168.50.50");
  });
  it("returns undefined when nothing suitable exists", () => {
    expect(detectLanIp({ lo: [a("127.0.0.1", true)], eth0: [a("8.8.8.8")] })).toBeUndefined();
  });
});
