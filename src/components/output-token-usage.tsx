import { memo, useEffect, useRef } from "react";
import type { TokenUsageSummary } from "@/shared/harness-usage";

const exactNumber = new Intl.NumberFormat("en-US");
const compactNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function formatTokens(value: number): string {
  const units = [
    { size: 1_000_000_000, suffix: "B" },
    { size: 1_000_000, suffix: "M" },
    { size: 1_000, suffix: "K" },
  ];
  const unit = units.find((entry) => value >= entry.size - entry.size / 20_000);
  return unit ? `${compactNumber.format(value / unit.size)}${unit.suffix}` : exactNumber.format(value);
}

export const OutputTokenUsage = memo(function OutputTokenUsage({
  usage,
}: {
  usage?: TokenUsageSummary | null;
}) {
  const numberRef = useRef<HTMLSpanElement>(null);
  const previousText = useRef<string | undefined>(undefined);
  const value = usage?.outputTokens;
  const text = value === undefined ? "\u2014" : formatTokens(value);

  useEffect(() => {
    const previous = previousText.current;
    previousText.current = text;
    if (previous === undefined || previous === text || value === undefined
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = numberRef.current?.animate([
      { opacity: 0.25, transform: "translateY(4px) scale(0.94)" },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ], { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    return () => animation?.cancel();
  }, [text, value]);

  const partial = value !== undefined && usage?.coverage === "partial";
  const stale = usage?.status === "stale";
  const detail = value === undefined
    ? "Output token usage unavailable"
    : `${exactNumber.format(value)} output tokens${partial ? ", partial coverage" : ""}${stale ? ", last known usage" : ""}`;

  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-gray-500 dark:text-gray-400">Output tokens</span>
      <span className="flex items-baseline gap-2" title={detail}>
        {(partial || stale) && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {partial ? "Partial" : ""}{partial && stale ? " \u00b7 " : ""}{stale ? "Last known" : ""}
          </span>
        )}
        <span
          ref={numberRef}
          className="inline-block origin-center font-medium tabular-nums text-gray-900 dark:text-gray-100"
          aria-label={detail}
        >
          {text}
        </span>
      </span>
    </div>
  );
});
