import { describe, expect, it } from "vitest";
import { parseProcNet } from "../src/server/ports/host.js";

const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

describe("parseProcNet", () => {
  it("counts only LISTEN sockets for tcp", () => {
    const tcp =
      header +
      "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1\n" + // 8080 listen
      "   1: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000     0        0 2 1\n"; // established
    expect([...parseProcNet(tcp, "tcp")]).toEqual(["8080/tcp"]);
  });

  it("counts bound udp sockets", () => {
    const udp = header + "   0: 00000000:2013 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 1 1\n"; // 8211
    expect([...parseProcNet(udp, "udp")]).toEqual(["8211/udp"]);
  });
});
