import type { ReactNode } from "react";
import { ActivitySpinner } from "./activity-spinner";

interface ThinkingIndicatorProps {
  children: ReactNode;
  label: string;
  isActive?: boolean;
  className?: string;
  dataReasoningSummary?: boolean;
}

export function ThinkingIndicator({
  children,
  label,
  isActive = false,
  className,
  dataReasoningSummary = false,
}: ThinkingIndicatorProps) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-2 rounded-md py-0.5 text-left text-xs text-gray-400 dark:text-white/28 ${className ?? ""}`.trim()}
      data-reasoning-summary={dataReasoningSummary ? "true" : undefined}
    >
      {isActive && <ActivitySpinner label={label} />}
      {children}
    </span>
  );
}
