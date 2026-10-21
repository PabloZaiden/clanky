import { memo, useEffect, useRef } from "react";
import type { TokenUsageSummary } from "@/shared/harness-usage";

const exactNumber = new Intl.NumberFormat("en-US");
const compactNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const percentage = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

function formatTokens(value: number): string {
  const units = [
    { size: 1_000_000_000, suffix: "B" },
    { size: 1_000_000, suffix: "M" },
    { size: 1_000, suffix: "K" },
  ];
  const unit = units.find((entry) => value >= entry.size - entry.size / 20_000);
  return unit ? `${compactNumber.format(value / unit.size)}${unit.suffix}` : exactNumber.format(value);
}

function UsageRow({
  label,
  text,
  description,
  usage,
}: {
  label: string;
  text: string;
  description: string;
  usage?: TokenUsageSummary | null;
}) {
  const numberRef = useRef<HTMLSpanElement>(null);
  const previousText = useRef<string | undefined>(undefined);
  const available = text !== "\u2014";

  useEffect(() => {
    const previous = previousText.current;
    previousText.current = text;
    if (previous === undefined || previous === text || !available
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = numberRef.current?.animate([
      { opacity: 0.25, transform: "translateY(4px) scale(0.94)" },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ], { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    return () => animation?.cancel();
  }, [text, available]);

  const partial = available && usage?.coverage === "partial";
  const stale = usage?.status === "stale";
  const detail = `${description}${partial ? ", partial coverage" : ""}${stale ? ", last known usage" : ""}`;

  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
      <span className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-2" title={detail}>
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
}

export const TokenUsage = memo(function TokenUsage({
  usage,
}: {
  usage?: TokenUsageSummary | null;
}) {
  const input = usage?.inputTokens;
  const cached = usage?.cacheReadTokens;
  const cachedShare = input !== undefined && input > 0 && cached !== undefined
    ? cached / input
    : undefined;

  return (
    <div className="space-y-2">
      {[
        { label: "Input tokens", value: input },
        { label: "Output tokens", value: usage?.outputTokens },
      ].map(({ label, value }) => (
        <UsageRow
          key={label}
          label={label}
          text={value === undefined ? "\u2014" : formatTokens(value)}
          description={value === undefined
            ? `${label} unavailable`
            : `${exactNumber.format(value)} ${label.toLowerCase()}`}
          usage={usage}
        />
      ))}
      <UsageRow
        label="Cached"
        text={cachedShare === undefined ? "\u2014" : percentage.format(cachedShare)}
        description={cachedShare === undefined
          ? "Cached input percentage unavailable"
          : `${percentage.format(cachedShare)} cached input, ${exactNumber.format(cached!)} of ${exactNumber.format(input!)} input tokens read from cache`}
        usage={usage}
      />
    </div>
  );
});
