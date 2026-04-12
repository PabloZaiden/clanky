import {
  Button,
  preventButtonFocusOnMouseDown,
  preventButtonFocusOnPointerDown,
  type ButtonProps,
} from "../common";

/**
 * Terminal touch controls should not take DOM focus away from the terminal,
 * otherwise mobile browsers may dismiss or reopen the software keyboard.
 */
export function TouchControlButton({
  onMouseDown,
  onPointerDown,
  ...props
}: ButtonProps) {
  return (
    <Button
      {...props}
      onMouseDown={(event) => preventButtonFocusOnMouseDown(event, onMouseDown)}
      onPointerDown={(event) => preventButtonFocusOnPointerDown(event, onPointerDown)}
    />
  );
}
