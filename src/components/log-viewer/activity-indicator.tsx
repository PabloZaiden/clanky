import type { ComponentPropsWithoutRef } from "react";
import { useDocumentVisibility } from "../../hooks/useDocumentVisibility";
import { useTextStateSwap } from "../../hooks/useTextStateSwap";

type ActivityIndicatorProps = ComponentPropsWithoutRef<"span"> & {
  active?: boolean;
  label?: string;
  transitionValue?: string;
};

export function ActivityIndicator({
  active = true,
  label,
  transitionValue,
  className = "",
  children,
  ...props
}: ActivityIndicatorProps) {
  const visible = useDocumentVisibility();
  const text = transitionValue ?? (typeof children === "string" ? children : "");
  const ref = useTextStateSwap(`${active}:${label ?? ""}:${text}`);
  return (
    <span
      {...props}
      ref={ref}
      className={`inline-flex max-w-full items-center gap-2 ${active ? "clanky-activity-active" : ""} ${active && visible ? "clanky-activity-breathing" : ""} ${className}`.trim()}
    >
      {active && (
        <>
          <span aria-hidden="true" className="h-[0.45rem] w-[0.45rem] shrink-0 rounded-full bg-current" />
          {label && <span className="sr-only">{label}</span>}
        </>
      )}
      {children}
    </span>
  );
}
