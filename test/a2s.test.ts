import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { parseA2sInfo, queryA2s } from "../src/server/players/a2s.js";

const info = (players: number, max: number) =>
  Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 0x11]), Buffer.from("My Server\0Map\0folder\0Palworld\0"), Buffer.from([0x01, 0x02, players, max, 0, 0x64, 0x6c, 0])]);

describe("parseA2sInfo", () => {
  it("reads players and max players", () => expect(parseA2sInfo(info(3, 32))).toEqual({ online: 3, max: 32 }));
  it("rejects other replies", () => {
    expect(parseA2sInfo(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 1, 2, 3, 4]))).toBeNull();
    expect(parseA2sInfo(Buffer.from("garbage"))).toBeNull();
    expect(parseA2sInfo(info(1, 2).subarray(0, 12))).toBeNull();
  });
});

describe("queryA2s", () => {
  let server: dgram.Socket | undefined;
  afterEach(() => server?.close());

  const serve = (handler: (msg: Buffer, reply: (b: Buffer) => void) => void) =>
    new Promise<number>((resolve) => {
      server = dgram.createSocket("udp4");
      server.on("message", (msg, rinfo) => handler(msg, (b) => server!.send(b, rinfo.port, rinfo.address)));
      server.bind(0, "127.0.0.1", () => resolve(server!.address().port));
    });

  it("answers a plain query", async () => {
    const port = await serve((_m, reply) => reply(info(5, 16)));
    expect(await queryA2s("127.0.0.1", port)).toEqual({ online: 5, max: 16 });
  });

  it("echoes the challenge when the server asks for one", async () => {
    const challenge = Buffer.from([1, 2, 3, 4]);
    const port = await serve((msg, reply) => {
      if (msg.subarray(-4).equals(challenge)) reply(info(2, 10));
      else reply(Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]), challenge]));
    });
    expect(await queryA2s("127.0.0.1", port)).toEqual({ online: 2, max: 10 });
  });

  it("gives null when nothing answers", async () => {
    const port = await serve(() => undefined);
    expect(await queryA2s("127.0.0.1", port, 200)).toBeNull();
  });
});
