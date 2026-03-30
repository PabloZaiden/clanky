import { Button } from "../common";

const buttonClassName = "min-h-[28px] shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px]";
const separatorClassName = "mx-0.5 h-4 w-px shrink-0 bg-neutral-600";

export interface ChatFocusModeBarProps {
  autoScroll: boolean;
  onAutoScrollChange: (value: boolean) => void;
  onExitFocusMode: () => void;
  applySafeAreaBottom?: boolean;
}

export function ChatFocusModeBar({
  autoScroll,
  onAutoScrollChange,
  onExitFocusMode,
  applySafeAreaBottom = false,
}: ChatFocusModeBarProps) {
  return (
    <div
      className={[
        "shrink-0 border-t border-neutral-800 bg-[#1e1e1e]",
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
          className={`${buttonClassName} text-gray-300`}
          onClick={onExitFocusMode}
          aria-label="Exit focus mode"
          title="Exit focus mode"
        >
          ✕
        </Button>

        <span className={separatorClassName} aria-hidden="true" />

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
