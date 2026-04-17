/**
 * ActionMenu component — a dropdown menu triggered by a button.
 * Used to collapse multiple actions behind a single toggle on mobile.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HamburgerIcon } from "./Icons";

export interface ActionMenuItem {
  /** Stable identifier for React keys */
  id?: string;
  /** Display label for the menu item */
  label: string;
  /** Callback when the item is clicked */
  onClick: () => void;
  /** Whether the item should be disabled */
  disabled?: boolean;
  /** Whether the item is destructive */
  destructive?: boolean;
}

export interface ActionMenuProps {
  /** List of menu items to display */
  items: ActionMenuItem[];
  /** Accessible label for the trigger button */
  ariaLabel?: string;
  /** Whether the trigger should be disabled */
  disabled?: boolean;
  /** Custom trigger content */
  triggerContent?: ReactNode;
  /** Visual treatment for the trigger button */
  triggerVariant?: "solid" | "ghost";
  /** Size treatment for the trigger button */
  triggerSize?: "default" | "compact";
}

export function ActionMenu({
  items,
  ariaLabel = "Actions",
  disabled = false,
  triggerContent,
  triggerVariant = "solid",
  triggerSize = "default",
}: ActionMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

  // Close on Escape key and click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        close();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [isOpen, close]);

  useEffect(() => {
    if (disabled) {
      close();
    }
  }, [close, disabled]);

  const handleItemClick = (item: ActionMenuItem) => {
    if (item.disabled) {
      return;
    }
    close();
    item.onClick();
  };

  const triggerVariantClassName = triggerVariant === "ghost"
    ? "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-gray-500 disabled:bg-gray-100 disabled:text-gray-400 dark:bg-transparent dark:text-gray-300 dark:hover:bg-neutral-800 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500"
    : "bg-gray-900 text-white hover:bg-gray-800 focus:ring-gray-400 disabled:bg-gray-300 disabled:text-gray-600 dark:bg-neutral-100 dark:text-gray-950 dark:hover:bg-neutral-200 dark:focus:ring-gray-500 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500";
  const triggerSizeClassName = triggerSize === "compact"
    ? "min-h-[32px] min-w-0 px-2 py-0.5 text-xs font-medium"
    : "min-h-[44px] min-w-[44px]";

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={`flex items-center justify-center rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed ${triggerVariantClassName} ${triggerSizeClassName}`}
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-haspopup="true"
        disabled={disabled}
      >
        {triggerContent ?? <HamburgerIcon />}
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-md bg-white shadow-lg ring-1 ring-black/5 dark:bg-neutral-800 dark:ring-gray-700"
          role="menu"
          aria-orientation="vertical"
        >
          <div className="py-1">
            {items.map((item, index) => (
              <button
                key={item.id ?? `${item.label}-${index}`}
                type="button"
                role="menuitem"
                onClick={() => handleItemClick(item)}
                disabled={item.disabled}
                className={`flex w-full items-center px-4 py-3 text-left text-sm transition-colors ${
                  item.destructive
                    ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                    : "text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-neutral-700"
                } ${item.disabled ? "cursor-not-allowed opacity-60" : ""}`.trim()}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ActionMenu;
