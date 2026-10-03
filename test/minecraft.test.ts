import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { parseStatusReply, queryMinecraft, statusRequest } from "../src/server/players/minecraft.js";

const varint = (n: number) => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};

/** A status reply as a server sends it: length, packet id 0, then the JSON as a length-prefixed string. */
function reply(json: object) {
  const text = Buffer.from(JSON.stringify(json));
  const body = Buffer.concat([varint(0), varint(text.length), text]);
  return Buffer.concat([varint(body.length), body]);
}

describe("Minecraft status ping", () => {
  it("builds the handshake and status request a client sends", () => {
    const b = statusRequest("play.example.com", 25565);
    // handshake: id 0, protocol 767 (0xff 0x05), host, port, next state 1; then the empty status request
    const host = Buffer.from("play.example.com");
    const handshake = Buffer.concat([Buffer.from([0x00, 0xff, 0x05, host.length]), host, Buffer.from([0x63, 0xdd, 0x01])]);
    expect(b).toEqual(Buffer.concat([Buffer.from([handshake.length]), handshake, Buffer.from([0x01, 0x00])]));
  });

  it("reads online and max players from a status reply, including a big one with an icon", () => {
    expect(parseStatusReply(reply({ version: { name: "1.21", protocol: 767 }, players: { max: 20, online: 3 } }))).toEqual({ online: 3, max: 20 });
    const big = reply({ players: { max: 8, online: 0 }, favicon: "data:image/png;base64," + "A".repeat(20_000) });
    expect(parseStatusReply(big)).toEqual({ online: 0, max: 8 });
  });

  it("waits for the whole reply and rejects replies that are not a status", () => {
    const whole = reply({ players: { max: 20, online: 3 } });
    expect(parseStatusReply(whole.subarray(0, 10))).toBeNull();
    expect(parseStatusReply(Buffer.alloc(0))).toBeNull();
    expect(parseStatusReply(reply({ description: "no players field" }))).toBeNull();
    expect(parseStatusReply(Buffer.concat([varint(3), varint(1), Buffer.from("ab")]))).toBeNull(); // packet id 1 is not a status reply
  });
});

describe("queryMinecraft", () => {
  let server: net.Server | undefined;
  const sockets = new Set<net.Socket>();
  const stop = () =>
    new Promise<void>((r) => {
      if (!server) return r();
      server.close(() => r());
      for (const c of sockets) c.destroy();
    });
  afterEach(stop);

  const listen = (onConn: (s: net.Socket) => void) =>
    new Promise<number>((resolve) => {
      server = net.createServer((c) => {
        sockets.add(c);
        onConn(c);
      }).listen(0, "127.0.0.1", () => resolve((server!.address() as net.AddressInfo).port));
    });

  it("asks a server and returns its player count, even when the reply arrives in pieces", async () => {
    let got = Buffer.alloc(0);
    const port = await listen((s) => {
      s.on("data", (d) => {
        got = Buffer.concat([got, d]);
        if (got.length < 3 || !got.toString("latin1").endsWith("\x01\x00")) return;
        const r = reply({ players: { max: 20, online: 5 } });
        s.write(r.subarray(0, 4));
        setTimeout(() => s.write(r.subarray(4)), 20);
      });
    });
    expect(await queryMinecraft("127.0.0.1", port)).toEqual({ online: 5, max: 20 });
    expect(got.subarray(-2)).toEqual(Buffer.from([0x01, 0x00]));
  });

  it("gives null when nothing is listening or the server stays silent", async () => {
    const port = await listen(() => undefined);
    expect(await queryMinecraft("127.0.0.1", port, 100)).toBeNull();
    await stop();
    server = undefined;
    expect(await queryMinecraft("127.0.0.1", port, 100)).toBeNull();
  });
});
