import os from "node:os";

type Ifaces = ReturnType<typeof os.networkInterfaces>;

const VIRTUAL = /^(docker|br-|veth|virbr|tailscale|ts|lo|zt|cni|flannel|wg)/;

/**
 * Best guess at this machine's LAN IPv4 address for when HOST_LAN_IP is not set: the first private IPv4 on a
 * physical-looking interface. Only meaningful with host networking, otherwise it sees the container's network.
 */
export function detectLanIp(ifaces: Ifaces = os.networkInterfaces()): string | undefined {
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return undefined;
}
