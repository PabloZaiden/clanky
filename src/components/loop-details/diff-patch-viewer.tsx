/**
 * Renders git-style diffs and apply_patch hunk content with lightweight line highlighting.
 */

export function DiffPatchViewer({ patch }: { patch: string }) {
  // Normalize line endings and split
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  return (
    <pre className="text-xs font-mono overflow-x-auto bg-neutral-950 p-3 rounded-b">
      {lines.map((line, i) => {
        let className = "text-gray-400";
        if (line.startsWith("+") && !line.startsWith("+++")) {
          className = "text-green-400 bg-green-950/50";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          className = "text-red-400 bg-red-950/50";
        } else if (line.startsWith("@@")) {
          className = "text-gray-300";
        } else if (line.startsWith("*** ")) {
          className = "text-sky-300";
        } else if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
          className = "text-gray-500";
        }
        return (
          <div key={i} className={className}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
