import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { FloatingPanel } from "@pablozaiden/webapp/web";
import { FocusPreservingButton, MicrophoneIcon } from "../common";
import { useLiveVoiceBusy } from "../../lib/voice-audio-ownership";

const TALK_HOLD_MS = 450;
const TALK_MOVE_THRESHOLD_PX = 10;

interface Press {
  pointerId: number;
  x: number;
  y: number;
  holding: boolean;
}

export function ComposerSendButton({ disabled, label, onStartVoice, children }: {
  disabled: boolean;
  label: string;
  onStartVoice?: () => Promise<void>;
  children: ReactNode;
}) {
  const liveVoiceBusy = useLiveVoiceBusy();
  const canTalk = Boolean(onStartVoice && !disabled && !liveVoiceBusy);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const targetRef = useRef<HTMLButtonElement>(null);
  const pressRef = useRef<Press | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(false);

  const cancel = useCallback((): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    const press = pressRef.current;
    pressRef.current = null;
    if (press && anchorRef.current?.hasPointerCapture(press.pointerId)) {
      anchorRef.current.releasePointerCapture(press.pointerId);
    }
    setOpen(false);
    setSelected(false);
  }, []);

  useEffect(() => {
    if (!canTalk) cancel();
    const handleBlur = (): void => {
      if (pressRef.current) suppressClickRef.current = true;
      cancel();
    };
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("blur", handleBlur);
      cancel();
    };
  }, [canTalk, cancel]);

  function isOverTarget(x: number, y: number): boolean {
    const bounds = targetRef.current?.getBoundingClientRect();
    return Boolean(bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom);
  }

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>): void {
    suppressClickRef.current = false;
    if (!canTalk || !event.isPrimary || event.button !== 0) return;
    cancel();
    const press: Press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, holding: false };
    pressRef.current = press;
    event.currentTarget.setPointerCapture(event.pointerId);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (pressRef.current !== press) return;
      press.holding = true;
      suppressClickRef.current = true;
      setOpen(true);
    }, TALK_HOLD_MS);
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>): void {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    if (press.holding) {
      setSelected(isOverTarget(event.clientX, event.clientY));
    } else if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > TALK_MOVE_THRESHOLD_PX) {
      suppressClickRef.current = true;
      cancel();
    }
  }

  function handlePointerUp(event: PointerEvent<HTMLButtonElement>): void {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    const activate = press.holding && canTalk && isOverTarget(event.clientX, event.clientY);
    if (press.holding) {
      event.preventDefault();
      suppressClickRef.current = true;
    }
    cancel();
    if (activate) void onStartVoice?.();
  }

  return (
    <>
      <FocusPreservingButton
        ref={anchorRef}
        type="submit"
        disabled={disabled}
        className="wapp-action-menu-trigger wapp-action-menu-trigger-compact flex-shrink-0 select-none"
        style={canTalk ? { touchAction: "none", WebkitTouchCallout: "none" } : undefined}
        aria-label={label}
        title={canTalk ? `${label}; hold and drag up for Talk` : label}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => { suppressClickRef.current = true; cancel(); }}
        onLostPointerCapture={() => { if (pressRef.current) { suppressClickRef.current = true; cancel(); } }}
        onContextMenu={(event) => { if (canTalk) event.preventDefault(); }}
        onClick={(event) => {
          if (suppressClickRef.current && event.detail !== 0) {
            event.preventDefault();
            event.stopPropagation();
          }
          suppressClickRef.current = false;
        }}
      >
        {children}
      </FocusPreservingButton>
      <FloatingPanel open={open} anchorRef={anchorRef} onClose={cancel}
        ariaLabel="Talk voice input" role="group" placement="top-end"
        className="clanky-composer-panel rounded-full border p-1">
        <button ref={targetRef} type="button" aria-label="Start Talk" title="Release here to start Talk"
          className={`flex h-12 w-12 items-center justify-center rounded-full ${selected
            ? "bg-blue-600 text-white" : "clanky-composer-button"}`}
          onClick={() => { cancel(); if (canTalk) void onStartVoice?.(); }}>
          <MicrophoneIcon />
        </button>
      </FloatingPanel>
    </>
  );
}
