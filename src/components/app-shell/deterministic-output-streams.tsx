interface DeterministicOutputLog {
  message: string;
  details?: Record<string, unknown>;
}

export function DeterministicOutputStreams({
  logs,
}: {
  logs: readonly DeterministicOutputLog[];
}) {
  const outputLogs = logs.filter((log) => {
    const stream = log.details?.["stream"];
    return stream === "stdout" || stream === "stderr";
  });
  const renderStream = (stream: "stdout" | "stderr") => outputLogs
    .filter((log) => log.details?.["stream"] === stream)
    .map((log) => log.message)
    .join("");

  const stdout = renderStream("stdout");
  const stderr = renderStream("stderr");
  return (
    <div className="grid gap-3 rounded-md border border-gray-200 bg-neutral-950 p-3 text-xs text-gray-100 dark:border-gray-700">
      <div className="min-w-0">
        <h2 className="font-semibold text-gray-300">stdout</h2>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{stdout || "(empty)"}</pre>
      </div>
      <div className="min-w-0">
        <h2 className="font-semibold text-red-300">stderr</h2>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-red-100">{stderr || "(empty)"}</pre>
      </div>
    </div>
  );
}
