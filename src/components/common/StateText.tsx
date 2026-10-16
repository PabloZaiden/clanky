import type { ComponentPropsWithoutRef } from "react";
import { useTextStateSwap } from "../../hooks/useTextStateSwap";

export function StateText({
  children,
  className = "",
  ...props
}: Omit<ComponentPropsWithoutRef<"span">, "children"> & { children: string }) {
  const ref = useTextStateSwap(children);
  return (
    <span {...props} ref={ref} className={`inline-block min-w-0 ${className}`.trim()}>
      {children}
    </span>
  );
}
