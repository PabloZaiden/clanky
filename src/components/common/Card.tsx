/**
 * Card component for containing content.
 */

import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Card title */
  title?: string;
  /** Card description */
  description?: string;
  /** Header actions (buttons, etc.) */
  headerActions?: ReactNode;
  /** Whether the card is clickable */
  clickable?: boolean;
  /** Whether to add padding */
  padding?: boolean;
  /** Additional classes for the content wrapper */
  bodyClassName?: string;
  /** Children content */
  children?: ReactNode;
}

export function Card({
  title,
  description,
  headerActions,
  clickable = false,
  padding = true,
  bodyClassName = "",
  children,
  className = "",
  ...props
}: CardProps) {
  const hasHeader = title || description || headerActions;

  return (
    <div
      className={`clanky-card rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-neutral-800 ${
        clickable ? "cursor-pointer hover:border-gray-300 hover:shadow-md dark:hover:border-gray-600" : ""
      } ${className}`}
      {...props}
    >
      {hasHeader && (
        <div className="flex items-start justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div>
            {title && (
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {title}
              </h3>
            )}
            {description && (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {description}
              </p>
            )}
          </div>
          {headerActions && (
            <div className="flex items-center gap-2">{headerActions}</div>
          )}
        </div>
      )}
      {children && (
        <div className={`${padding ? "p-4" : ""} ${bodyClassName}`.trim()}>{children}</div>
      )}
    </div>
  );
}

export default Card;
