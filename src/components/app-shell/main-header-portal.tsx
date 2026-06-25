import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const MAIN_HEADER_TITLE_SLOT_ID = "clanky-main-header-title-slot";
const MAIN_HEADER_ACTIONS_SLOT_ID = "clanky-main-header-actions-slot";

function useHeaderSlot(id: string): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setTarget(document.getElementById(id));
  }, [id]);

  return target;
}

export function FrameworkMainHeaderTitleSlot({ fallback }: { fallback: ReactNode }) {
  return (
    <>
      <span id={MAIN_HEADER_TITLE_SLOT_ID} className="flex min-w-0 max-w-full flex-1 items-center gap-1.5 overflow-hidden" />
      <span className="clanky-main-header-title-fallback min-w-0 truncate">{fallback}</span>
    </>
  );
}

export function FrameworkMainHeaderActionsSlot() {
  return <span id={MAIN_HEADER_ACTIONS_SLOT_ID} className="flex min-w-max flex-shrink-0 items-center justify-end gap-1.5 overflow-visible" />;
}

export function useFrameworkMainHeaderSlots() {
  const titleTarget = useHeaderSlot(MAIN_HEADER_TITLE_SLOT_ID);
  const actionsTarget = useHeaderSlot(MAIN_HEADER_ACTIONS_SLOT_ID);
  return {
    titleTarget,
    actionsTarget,
    available: Boolean(titleTarget && actionsTarget),
  };
}

export function FrameworkMainHeaderPortal({
  title,
  description,
  descriptionClassName,
  badges,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  descriptionClassName?: string;
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  const { titleTarget, actionsTarget } = useFrameworkMainHeaderSlots();
  return (
    <>
      {titleTarget ? createPortal(
        <>
          <span className="min-w-0 flex-shrink truncate text-lg font-bold text-gray-900 dark:text-gray-100">
            {title}
          </span>
          {badges ? <span className="flex flex-shrink-0 items-center gap-1.5">{badges}</span> : null}
          {description ? (
            <span
              className={[
                "min-w-0 flex-shrink truncate text-xs font-normal text-gray-500 dark:text-gray-400",
                descriptionClassName ?? "",
              ].join(" ").trim()}
            >
              {description}
            </span>
          ) : null}
        </>,
        titleTarget,
      ) : null}
      {actionsTarget && actions ? createPortal(actions, actionsTarget) : null}
    </>
  );
}
