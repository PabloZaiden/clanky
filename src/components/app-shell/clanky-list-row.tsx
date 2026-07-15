import type { ReactNode } from "react";
import { getPrivateContainerClassName } from "../../lib/private-items";

export function ClankyListRow({
  title,
  description,
  meta,
  badge,
  onClick,
  privateHidden = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  onClick?: () => void;
  privateHidden?: boolean;
}) {
  const className = [
    "flex w-full items-start gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-left shadow-sm transition dark:border-gray-800 dark:bg-neutral-900",
    onClick && !privateHidden ? "hover:border-gray-300 hover:bg-gray-50 dark:hover:border-gray-700 dark:hover:bg-neutral-800" : "",
    getPrivateContainerClassName(privateHidden),
  ].filter(Boolean).join(" ");

  const content = (
    <>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{title}</div>
        {description ? <div className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">{description}</div> : null}
      </div>
      {meta ? <div className="shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">{meta}</div> : null}
      {badge ? <div className="shrink-0">{badge}</div> : null}
    </>
  );

  return onClick && !privateHidden ? (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}
