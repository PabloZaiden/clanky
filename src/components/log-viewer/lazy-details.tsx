import type { ReactNode } from "react";
import { memo, useState } from "react";

interface LazyDetailsProps {
  /** Summary content shown in the collapsed header (accepts ReactNode for rich content). */
  summary: ReactNode;
  renderContent: () => ReactNode;
  /** Whether the details element starts open. Defaults to false. */
  defaultOpen?: boolean;
}

export const LazyDetails = memo(function LazyDetails({
  summary,
  renderContent,
  defaultOpen = false,
}: LazyDetailsProps) {
  const [hasOpened, setHasOpened] = useState(defaultOpen);

  return (
    <details
      className="mt-1"
      open={defaultOpen}
      onToggle={(event) => {
        if (event.currentTarget.open) {
          setHasOpened(true);
        }
      }}
    >
      <summary className="cursor-pointer text-gray-500 hover:text-gray-400 text-xs">
        {summary}
      </summary>
      {hasOpened ? renderContent() : null}
    </details>
  );
});
