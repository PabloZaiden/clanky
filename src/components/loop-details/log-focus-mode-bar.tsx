import { Button } from "../common";

const buttonClassName = "min-h-[28px] shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px]";
const separatorClassName = "mx-0.5 h-4 w-px shrink-0 bg-gray-300 dark:bg-neutral-600";

export interface LogFocusModeBarProps {
  showSystemInfo: boolean;
  onShowSystemInfoChange: (value: boolean) => void;
  showReasoning: boolean;
  onShowReasoningChange: (value: boolean) => void;
  showTools: boolean;
  onShowToolsChange: (value: boolean) => void;
  autoScroll: boolean;
  onAutoScrollChange: (value: boolean) => void;
  onExitFocusMode: () => void;
  applySafeAreaBottom?: boolean;
}

export function LogFocusModeBar({
  showSystemInfo,
  onShowSystemInfoChange,
  showReasoning,
  onShowReasoningChange,
  showTools,
  onShowToolsChange,
  autoScroll,
  onAutoScrollChange,
  onExitFocusMode,
  applySafeAreaBottom = false,
}: LogFocusModeBarProps) {
  return (
      <div
        className={[
          "shrink-0 border-t border-gray-200 bg-white/95 dark:border-neutral-800 dark:bg-[#1e1e1e]",
          applySafeAreaBottom ? "safe-area-bottom" : "",
        ].join(" ").trim()}
      >
      <div
        className="hide-scrollbar flex items-center gap-1 overflow-x-auto px-1.5 py-1.5"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        <Button
          variant="ghost"
          size="xs"
          className={`${buttonClassName} text-gray-700 dark:text-gray-300`}
          onClick={onExitFocusMode}
          aria-label="Exit focus mode"
          title="Exit focus mode"
        >
          ✕
        </Button>

        <span className={separatorClassName} aria-hidden="true" />

        <Button
          variant={showSystemInfo ? "primary" : "secondary"}
          size="xs"
          className={buttonClassName}
          onClick={() => onShowSystemInfoChange(!showSystemInfo)}
          aria-pressed={showSystemInfo}
        >
          System
        </Button>
        <Button
          variant={showReasoning ? "primary" : "secondary"}
          size="xs"
          className={buttonClassName}
          onClick={() => onShowReasoningChange(!showReasoning)}
          aria-pressed={showReasoning}
        >
          Reasoning
        </Button>
        <Button
          variant={showTools ? "primary" : "secondary"}
          size="xs"
          className={buttonClassName}
          onClick={() => onShowToolsChange(!showTools)}
          aria-pressed={showTools}
        >
          Tools
        </Button>
        <Button
          variant={autoScroll ? "primary" : "secondary"}
          size="xs"
          className={buttonClassName}
          onClick={() => onAutoScrollChange(!autoScroll)}
          aria-pressed={autoScroll}
        >
          Autoscroll
        </Button>
      </div>
    </div>
  );
}
