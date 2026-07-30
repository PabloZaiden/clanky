import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FloatingPanel, OverflowIcon } from "@pablozaiden/webapp/web";

interface ComposerActionsMenuProps {
  ariaLabel: string;
  disabled?: boolean;
  children: ReactNode;
}

export function ComposerActionsMenu({
  ariaLabel,
  disabled = false,
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
        className="wapp-action-menu-trigger wapp-action-menu-trigger-compact relative flex-shrink-0"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-controls={isOpen ? menuId : undefined}
        data-testid="composer-actions-trigger"
      >
        <OverflowIcon />
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
        className="clanky-composer-panel max-h-[min(24rem,calc(100vh-1rem))] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-lg p-3"
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
      <p className="clanky-composer-label text-xs font-medium uppercase tracking-wide">
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
      className="clanky-composer-button flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm"
    >
      {children}
    </button>
  );
}
