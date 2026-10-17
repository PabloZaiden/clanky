import { memo, useEffect, useRef } from "react";

export const ConsoleOutput = memo(function ConsoleOutput({ entries }: {
  entries: readonly { id: string | number; text: string }[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [entries]);
  return <div ref={containerRef} aria-label="Command output"
    className="max-h-80 overflow-auto rounded-md border border-gray-200 bg-neutral-950 p-3 font-mono text-base text-gray-100 dark:border-gray-700">
    {entries.length ? entries.map((entry) => <div key={entry.id} className="whitespace-pre-wrap break-words">{entry.text}</div>)
      : <div className="text-gray-400">Waiting for output.</div>}
  </div>;
});
