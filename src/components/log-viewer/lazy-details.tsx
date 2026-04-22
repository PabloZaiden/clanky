import type { ReactNode } from "react";
import { memo, useState } from "react";

interface LazyDetailsProps {
  /** Summary content shown in the collapsed header (accepts ReactNode for rich content). */
  summary: ReactNode;
  renderContent: () => ReactNode;
  /** Whether the details element starts open. Defaults to false. */
  defaultOpen?: boolean;
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
  className,
  triggerClassName,
  panelClassName,
}: LazyDetailsProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [hasOpened, setHasOpened] = useState(defaultOpen);

  return (
    <div
      className={className ?? "mt-1"}
      data-open={isOpen ? "true" : "false"}
    >
      <button
        type="button"
        aria-expanded={isOpen}
        className={triggerClassName ?? "cursor-pointer text-gray-500 hover:text-gray-400 text-xs"}
        onClick={() => {
          const nextOpen = !isOpen;
          setIsOpen(nextOpen);
          if (nextOpen) {
            setHasOpened(true);
          }
        }}
      >
        {summary}
      </button>
      {hasOpened ? (
        <div className={`${panelClassName ?? "mt-1"} ${isOpen ? "" : "hidden"}`.trim()}>
          {renderContent()}
        </div>
      ) : null}
    </div>
  );
});
