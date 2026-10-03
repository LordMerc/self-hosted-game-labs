import net from "node:net";
import type { PlayerCount } from "./a2s.js";

function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return Buffer.from(out);
}

/** Read a varint at `at`: its value and the byte after it, or null when the bytes are not all here yet. */
function readVarint(buf: Buffer, at: number): { value: number; next: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (at + i >= buf.length) return null;
    const b = buf[at + i];
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value, next: at + i + 1 };
  }
  throw new Error("bad varint");
}

/** Protocol version sent in the handshake. Servers answer a status request whatever version it claims. */
const PROTOCOL = 767;

const packet = (body: Buffer) => Buffer.concat([varint(body.length), body]);

/** The two packets a Java client sends to ask for the server list entry: handshake (next state: status), then status request. */
export function statusRequest(host: string, port: number): Buffer {
  const h = Buffer.from(host, "utf8");
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  const handshake = Buffer.concat([varint(0x00), varint(PROTOCOL), varint(h.length), h, portBytes, varint(1)]);
  return Buffer.concat([packet(handshake), packet(varint(0x00))]);
}

/** Player counts out of a complete status reply (length, packet id 0, JSON string). Null if it is not one, or not complete yet. */
export function parseStatusReply(buf: Buffer): PlayerCount | null {
  const len = readVarint(buf, 0);
  if (!len || buf.length < len.next + len.value) return null;
  const id = readVarint(buf, len.next);
  if (!id || id.value !== 0) return null;
  const strLen = readVarint(buf, id.next);
  if (!strLen) return null;
  const json = buf.subarray(strLen.next, strLen.next + strLen.value).toString("utf8");
  try {
    const p = (JSON.parse(json) as { players?: { online?: unknown; max?: unknown } }).players;
    if (typeof p?.online !== "number" || typeof p.max !== "number") return null;
    return { online: p.online, max: p.max };
  } catch {
    return null;
  }
}

/**
 * Ask a Minecraft Java server how many players it has, the same way the multiplayer menu does (server list ping over
 * the game's own TCP port). Resolves to null on timeout, refusal or an unexpected reply, never throws.
 */
export function queryMinecraft(host: string, port: number, timeoutMs = 2000): Promise<PlayerCount | null> {
  return new Promise((resolve) => {
    let chunks = Buffer.alloc(0);
    const sock = net.connect({ host, port });
    const done = (r: PlayerCount | null) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on("connect", () => sock.write(statusRequest(host, port)));
    sock.on("data", (d: Buffer) => {
      chunks = Buffer.concat([chunks, d]);
      try {
        const r = parseStatusReply(chunks);
        if (r) done(r);
        else if (chunks.length > 64 * 1024) done(null);
      } catch {
        done(null);
      }
    });
    sock.on("error", () => done(null));
    sock.on("close", () => done(null));
  });
}
