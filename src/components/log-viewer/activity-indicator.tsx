import type { ComponentPropsWithoutRef } from "react";
import { useDocumentVisibility } from "../../hooks/useDocumentVisibility";

type ActivityIndicatorProps = ComponentPropsWithoutRef<"span"> & {
  active?: boolean;
  label?: string;
};

export function ActivityIndicator({
  active = true,
  label,
  className = "",
  children,
  ...props
}: ActivityIndicatorProps) {
  const visible = useDocumentVisibility();
  return (
    <span
      {...props}
      className={`inline-flex max-w-full items-center gap-2 ${active && visible ? "clanky-activity-breathing" : ""} ${className}`.trim()}
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
