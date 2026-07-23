import type { ReactNode } from "react";
import { memo, useId, useState } from "react";

interface LazyDetailsProps {
  /** Summary content shown in the collapsed header (accepts ReactNode for rich content). */
  summary: ReactNode;
  renderContent: () => ReactNode;
  /** Whether the details element starts open. Defaults to false. */
  defaultOpen?: boolean;
  /** Runs when the details are opened for the first time or reopened. */
  onOpen?: () => void;
  /** Additional classes applied to the root wrapper. */
  className?: string;
  /** Additional classes applied to the trigger button. */
  triggerClassName?: string;
  /** Additional classes applied to the mounted content wrapper. */
  panelClassName?: string;
}

export const LazyDetails = memo(function LazyDetails({
  summary,
  renderContent,
  defaultOpen = false,
  onOpen,
  className,
  triggerClassName,
  panelClassName,
}: LazyDetailsProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [hasOpened, setHasOpened] = useState(defaultOpen);
  const reactId = useId();
  const triggerId = `lazy-details-trigger-${reactId}`;
  const panelId = `lazy-details-panel-${reactId}`;

  return (
    <div
      className={className ?? "mt-1"}
      data-open={isOpen ? "true" : "false"}
    >
      <button
        id={triggerId}
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        className={triggerClassName ?? "cursor-pointer text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"}
        onClick={() => {
          const nextOpen = !isOpen;
          setIsOpen(nextOpen);
          if (nextOpen) {
            setHasOpened(true);
            onOpen?.();
          }
        }}
      >
        {summary}
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        hidden={!isOpen}
        className={panelClassName ?? "mt-1"}
      >
        {hasOpened ? renderContent() : null}
      </div>
    </div>
  );
});
