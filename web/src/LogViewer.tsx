import { useEffect, useRef, useState } from "react";

const MAX_LINES = 1000;
const MAX_LINE_LENGTH = 2000;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Make a raw container log line safe and readable: no colour codes, no carriage-return progress spam, no NULs. */
export function cleanLine(raw: string): string {
  const afterCr = raw.split("\r").filter(Boolean).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const line = afterCr.replace(ANSI, "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
}

export function LogViewer({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [note, setNote] = useState("Connecting…");
  const pending = useRef<string[]>([]);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/servers/${id}/logs`);
    es.onopen = () => setNote("");
    es.onmessage = (e) => {
      try {
        pending.current.push(cleanLine(JSON.parse(e.data) as string));
      } catch {
        /* ignore a malformed message */
      }
    };
    es.onerror = () => setNote("Connection lost, retrying…");
    // Batch updates: a busy game can log hundreds of lines per second.
    const flush = setInterval(() => {
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      setLines((l) => [...l, ...batch].slice(-MAX_LINES));
    }, 250);
    return () => {
      clearInterval(flush);
      es.close();
    };
  }, [id]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  return (
    <div className="backdrop">
      <div className="card dialog logs">
        <div className="row between">
          <h2>{name} logs</h2>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {note && <p className="muted">{note}</p>}
        <pre className="mono">
          {lines.length === 0 ? "Waiting for output…" : lines.join("\n")}
          <span ref={end} />
        </pre>
      </div>
    </div>
  );
}
