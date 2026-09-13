import { useEffect, useRef, useState } from "react";
import type { LogLine } from "../../shared/types.ts";

export function LogView({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, follow]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  return (
    <div>
      <div ref={ref} className="log" onScroll={onScroll}>
        {lines.map((l) => (
          <div key={l.seq} className={`l-${l.level} k-${l.kind} s-${l.stream}`}>
            {l.text}
          </div>
        ))}
        {lines.length === 0 && <span className="muted">No output yet.</span>}
      </div>
      {!follow && (
        <button style={{ marginTop: 6 }} onClick={() => setFollow(true)}>
          Jump to latest
        </button>
      )}
    </div>
  );
}
