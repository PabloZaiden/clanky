import type React from "react";

export interface FocusPreservingButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export function preventButtonFocusOnMouseDown(
  event: React.MouseEvent<HTMLButtonElement>,
  onMouseDown?: React.MouseEventHandler<HTMLButtonElement>,
) {
  onMouseDown?.(event);
  if (!event.defaultPrevented) {
    event.preventDefault();
  }
}

export function preventButtonFocusOnPointerDown(
  event: React.PointerEvent<HTMLButtonElement>,
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>,
) {
  onPointerDown?.(event);
  if (!event.defaultPrevented && event.pointerType !== "mouse") {
    event.preventDefault();
  }
}

/**
 * Prevents press interactions from moving DOM focus onto the button, which
 * helps mobile browsers keep the software keyboard stable while still allowing
 * normal click activation.
 */
export function FocusPreservingButton({
  onMouseDown,
  onPointerDown,
  ...props
}: FocusPreservingButtonProps) {
  return (
    <button
      {...props}
      onMouseDown={(event) => preventButtonFocusOnMouseDown(event, onMouseDown)}
      onPointerDown={(event) => preventButtonFocusOnPointerDown(event, onPointerDown)}
    />
  );
}
