import type { Terminal } from "@xterm/xterm";
import { TERMINAL_FONT_SIZE_PX } from "./terminal-constants";

export type TerminalMouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";

export interface TerminalScrollBuffer {
  type: "normal" | "alternate";
  baseY: number;
}

export interface TerminalWheelInput {
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
}

export function hasTerminalScrollback(buffer: TerminalScrollBuffer): boolean {
  return buffer.type === "normal" && buffer.baseY > 0;
}

export function shouldCaptureTerminalWheel(input: {
  buffer: TerminalScrollBuffer;
  mouseTrackingMode: TerminalMouseTrackingMode;
  shiftKey: boolean;
}): boolean {
  // Shift+wheel remains available for TUIs that intentionally consume wheel reports.
  return (
    hasTerminalScrollback(input.buffer)
    && input.mouseTrackingMode !== "none"
    && !input.shiftKey
  );
}

export function getWheelDeltaLines(
  event: TerminalWheelInput,
  cellHeight: number,
  rows: number,
): number {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) {
    return 0;
  }

  if (event.deltaMode === 1) {
    return event.deltaY;
  }
  if (event.deltaMode === 2) {
    return event.deltaY * Math.max(rows, 1);
  }

  const safeCellHeight = Number.isFinite(cellHeight) && cellHeight > 0 ? cellHeight : 1;
  return event.deltaY / safeCellHeight;
}

export function takeWholeScrollLines(value: number): { lines: number; remainder: number } {
  const lines = Math.trunc(value);
  return {
    lines,
    remainder: value - lines,
  };
}

export function attachTerminalScrollBehavior(terminal: Terminal): () => void {
  let wheelLineRemainder = 0;
  let touchScrollState: {
    identifier: number;
    lastY: number;
    lineRemainder: number;
    didScroll: boolean;
  } | null = null;

  function getCellHeight(): number {
    const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
    const height = screen?.getBoundingClientRect().height ?? 0;
    return terminal.rows > 0 && height > 0 ? height / terminal.rows : TERMINAL_FONT_SIZE_PX;
  }

  function handleWheel(event: WheelEvent): boolean {
    if (event.deltaY === 0) {
      return true;
    }

    const buffer = terminal.buffer.active;
    if (
      !shouldCaptureTerminalWheel({
        buffer: {
          type: buffer.type,
          baseY: buffer.baseY,
        },
        mouseTrackingMode: terminal.modes.mouseTrackingMode,
        shiftKey: event.shiftKey,
      })
    ) {
      wheelLineRemainder = 0;
      return true;
    }

    wheelLineRemainder += getWheelDeltaLines(event, getCellHeight(), terminal.rows);
    const result = takeWholeScrollLines(wheelLineRemainder);
    wheelLineRemainder = result.remainder;
    if (result.lines !== 0) {
      terminal.scrollLines(result.lines);
    }
    return false;
  }

  function handleTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) {
      touchScrollState = null;
      return;
    }

    const buffer = terminal.buffer.active;
    if (!hasTerminalScrollback({ type: buffer.type, baseY: buffer.baseY })) {
      touchScrollState = null;
      return;
    }

    const touch = event.touches[0];
    if (!touch) {
      touchScrollState = null;
      return;
    }
    touchScrollState = {
      identifier: touch.identifier,
      lastY: touch.clientY,
      lineRemainder: 0,
      didScroll: false,
    };
  }

  function handleTouchMove(event: TouchEvent): void {
    if (!touchScrollState || event.touches.length !== 1) {
      touchScrollState = null;
      return;
    }

    const touch = event.touches[0];
    if (!touch || touch.identifier !== touchScrollState.identifier) {
      touchScrollState = null;
      return;
    }

    const buffer = terminal.buffer.active;
    if (!hasTerminalScrollback({ type: buffer.type, baseY: buffer.baseY })) {
      touchScrollState = null;
      return;
    }

    const deltaY = touch.clientY - touchScrollState.lastY;
    touchScrollState.lastY = touch.clientY;
    touchScrollState.lineRemainder += deltaY / getCellHeight();
    const result = takeWholeScrollLines(touchScrollState.lineRemainder);
    touchScrollState.lineRemainder = result.remainder;
    if (result.lines === 0) {
      return;
    }

    terminal.scrollLines(-result.lines);
    touchScrollState.didScroll = true;
    if (event.cancelable) {
      event.preventDefault();
    }
  }

  function handleTouchEnd(event: TouchEvent): void {
    if (touchScrollState?.didScroll && event.cancelable) {
      event.preventDefault();
    }
    touchScrollState = null;
  }

  function handleTouchCancel(): void {
    touchScrollState = null;
  }

  terminal.attachCustomWheelEventHandler(handleWheel);
  const terminalElement = terminal.element;
  if (!terminalElement) {
    return () => undefined;
  }

  terminalElement.addEventListener("touchstart", handleTouchStart, { passive: false });
  terminalElement.addEventListener("touchmove", handleTouchMove, { passive: false });
  terminalElement.addEventListener("touchend", handleTouchEnd, { passive: false });
  terminalElement.addEventListener("touchcancel", handleTouchCancel);

  return () => {
    terminalElement.removeEventListener("touchstart", handleTouchStart);
    terminalElement.removeEventListener("touchmove", handleTouchMove);
    terminalElement.removeEventListener("touchend", handleTouchEnd);
    terminalElement.removeEventListener("touchcancel", handleTouchCancel);
    touchScrollState = null;
  };
}
