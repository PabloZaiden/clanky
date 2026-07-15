import type { ReactNode } from "react";
import { getPrivateContainerClassName } from "../../lib/private-items";

export function ClankyListRow({
  title,
  description,
  descriptionClassName = "truncate",
  meta,
  metaPlacement = "side",
  badge,
  onClick,
  privateHidden = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  descriptionClassName?: string;
  meta?: ReactNode;
  metaPlacement?: "side" | "below";
  badge?: ReactNode;
  onClick?: () => void;
  privateHidden?: boolean;
}) {
  const className = [
    "flex w-full min-w-0 items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition dark:border-gray-800 dark:bg-neutral-900",
    onClick && !privateHidden ? "hover:border-gray-300 hover:bg-gray-100 dark:hover:border-gray-700 dark:hover:bg-neutral-800" : "",
    getPrivateContainerClassName(privateHidden),
  ].filter(Boolean).join(" ");

  const content = (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="block break-words text-sm font-medium text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">{title}</div>
        {description ? <div className={`mt-1 block text-xs text-gray-500 dark:text-gray-400 ${descriptionClassName}`}>{description}</div> : null}
        {meta && metaPlacement === "below" ? (
          <div className="mt-2 block break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]">{meta}</div>
        ) : null}
      </div>
      {meta && metaPlacement === "side" ? (
        <div className="shrink-0 whitespace-nowrap rounded-full bg-gray-200 px-2 py-0.5 text-right text-xs font-semibold text-gray-600 dark:bg-neutral-800 dark:text-gray-300">
          {meta}
        </div>
      ) : null}
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
