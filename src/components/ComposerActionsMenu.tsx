import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FloatingPanel } from "@pablozaiden/webapp/web";
import { HamburgerIcon } from "./common";

interface ComposerActionsMenuProps {
  ariaLabel: string;
  disabled?: boolean;
  hasPendingActions?: boolean;
  children: ReactNode;
}

export function ComposerActionsMenu({
  ariaLabel,
  disabled = false,
  hasPendingActions = false,
  children,
}: ComposerActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  useEffect(() => {
    if (disabled) {
      close();
    }
  }, [close, disabled]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        disabled={disabled}
        className="relative inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 shadow-sm transition hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-200 dark:hover:border-gray-500 dark:focus:ring-gray-600"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-controls={isOpen ? menuId : undefined}
        data-testid="composer-actions-trigger"
      >
        <HamburgerIcon size="h-5 w-5" />
        {hasPendingActions && (
          <span
            className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-500 ring-1 ring-white dark:ring-neutral-700"
            aria-hidden="true"
          />
        )}
      </button>
      <FloatingPanel
        open={isOpen}
        anchorRef={triggerRef}
        onClose={() => close()}
        ariaLabel={ariaLabel}
        role="group"
        id={menuId}
        placement="top-start"
        focusSelector="button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"
        restoreFocusOnClose
        className="max-h-[min(24rem,calc(100vh-1rem))] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-gray-200 bg-white p-3 shadow-xl ring-1 ring-black/5 dark:border-gray-700 dark:bg-neutral-800 dark:ring-gray-700"
      >
        <div className="space-y-3">
          {children}
        </div>
      </FloatingPanel>
    </>
  );
}

export function ComposerActionsMenuSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </p>
      {children}
    </section>
  );
}

export function ComposerActionsMenuButton({
  children,
  disabled = false,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center justify-between gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-sm text-gray-700 transition hover:border-gray-400 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-200 dark:hover:border-gray-500 dark:hover:bg-neutral-600 dark:focus:ring-gray-600"
    >
      {children}
    </button>
  );
}
