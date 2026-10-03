import { useEffect, useRef, useState } from "react";

export function LogViewer({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/servers/${id}/logs`);
    es.onmessage = (e) => setLines((l) => [...l.slice(-999), JSON.parse(e.data) as string]);
    return () => es.close();
  }, [id]);

  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [lines]);

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="card dialog logs" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>{name} logs</h2>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <pre className="mono">
          {lines.length === 0 ? "Waiting for output…" : lines.join("\n")}
          <div ref={end} />
        </pre>
      </div>
    </div>
  );
}
