import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HamburgerIcon } from "./common";

interface ComposerActionsMenuProps {
  ariaLabel: string;
  disabled?: boolean;
  hasPendingActions?: boolean;
  children: ReactNode;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  visibility: "hidden" | "visible";
}

export function ComposerActionsMenu({
  ariaLabel,
  disabled = false,
  hasPendingActions = false,
  children,
}: ComposerActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((returnFocus = false) => {
    setIsOpen(false);
    setPosition(null);
    if (returnFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const updatePosition = useCallback((visibility: MenuPosition["visibility"] = "visible") => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const margin = 8;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menuRef.current?.getBoundingClientRect();
    const width = Math.min(320, Math.max(240, window.innerWidth - margin * 2));
    const left = Math.min(
      Math.max(margin, triggerRect.left),
      Math.max(margin, window.innerWidth - width - margin),
    );
    const menuHeight = menuRect?.height ?? 0;
    const preferredTop = triggerRect.top - menuHeight - margin;
    const fallbackTop = triggerRect.bottom + margin;
    const top = preferredTop >= margin
      ? preferredTop
      : Math.min(fallbackTop, Math.max(margin, window.innerHeight - menuHeight - margin));

    setPosition({ left, top, width, visibility });
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    updatePosition("hidden");
    requestAnimationFrame(() => {
      updatePosition("visible");
      const firstControl = menuRef.current?.querySelector<HTMLElement>(
        "button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      );
      firstControl?.focus();
    });
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      const path = event.composedPath();
      const trigger = triggerRef.current;
      const menuElement = menuRef.current;
      if ((trigger && path.includes(trigger)) || (menuElement && path.includes(menuElement))) {
        return;
      }
      if (!(target instanceof Node)) {
        return;
      }
      if (trigger?.contains(target) || menuElement?.contains(target)) {
        return;
      }
      close();
    };

    const handleViewportChange = () => updatePosition();

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [close, isOpen, updatePosition]);

  useEffect(() => {
    if (disabled) {
      close();
    }
  }, [close, disabled]);

  const menu = isOpen && position ? createPortal(
    <div
      id={menuId}
      ref={menuRef}
      role="group"
      aria-label={ariaLabel}
      className="fixed z-50 max-h-[min(24rem,calc(100vh-1rem))] overflow-y-auto rounded-lg border border-gray-200 bg-white p-3 shadow-xl ring-1 ring-black/5 dark:border-gray-700 dark:bg-neutral-800 dark:ring-gray-700"
      style={{
        left: position.left,
        top: position.top,
        width: position.width,
        visibility: position.visibility,
      }}
    >
      <div className="space-y-3">
        {children}
      </div>
    </div>,
    document.body,
  ) : null;

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
      {menu}
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
