import dgram from "node:dgram";

export interface PlayerCount {
  online: number;
  max: number;
}

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const request = (challenge?: Buffer) => Buffer.concat([HEADER, Buffer.from("TSource Engine Query\0"), challenge ?? Buffer.alloc(0)]);

/** Read the player counts out of an A2S_INFO reply (header byte 0x49). Null if it is not one. */
export function parseA2sInfo(msg: Buffer): PlayerCount | null {
  if (msg.length < 6 || !msg.subarray(0, 4).equals(HEADER) || msg[4] !== 0x49) return null;
  let i = 6; // header, type, protocol version
  for (let strings = 0; strings < 4; strings++) {
    // name, map, folder, game
    const end = msg.indexOf(0, i);
    if (end < 0) return null;
    i = end + 1;
  }
  i += 2; // app id
  if (i + 2 > msg.length) return null;
  return { online: msg[i], max: msg[i + 1] };
}

/**
 * Ask a Steam-style game server how many players it has (A2S_INFO). Newer servers answer first with a
 * challenge that must be echoed back. Resolves to null on timeout or an unexpected reply, never throws.
 */
export function queryA2s(host: string, port: number, timeoutMs = 1500): Promise<PlayerCount | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let sentChallenge = false;
    const done = (r: PlayerCount | null) => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(r);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on("error", () => done(null));
    sock.on("message", (msg) => {
      if (msg.length >= 9 && msg[4] === 0x41 && !sentChallenge) {
        sentChallenge = true;
        sock.send(request(msg.subarray(5, 9)), port, host);
        return;
      }
      done(parseA2sInfo(msg));
    });
    sock.send(request(), port, host, (err) => err && done(null));
  });
}
