import { useMemo } from "react";
import {
  hasActiveTerminalModifiers,
  type TerminalModifierState,
  type TerminalSpecialKey,
} from "../../utils/terminal-keys";
import { TouchControlButton } from "./touch-control-button";

const btnClass = "min-h-[28px] shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px]";

const separatorClass = "mx-0.5 h-4 w-px shrink-0 bg-neutral-600";

export interface FocusModeBarProps {
  terminalModifiers: TerminalModifierState;
  hasSelectedTerminalText: boolean;
  toggleTerminalModifier: (modifier: keyof TerminalModifierState) => void;
  resetTerminalModifiers: () => void;
  copySelectedTerminalText: () => void;
  sendEncodedTerminalKey: (key: TerminalSpecialKey | string) => void;
  sendCtrlC: () => void;
  sendTerminalTextShortcut: (data: string) => void;
  onExitFocusMode: () => void;
}

export function FocusModeBar({
  terminalModifiers,
  hasSelectedTerminalText,
  toggleTerminalModifier,
  resetTerminalModifiers,
  copySelectedTerminalText,
  sendEncodedTerminalKey,
  sendCtrlC,
  sendTerminalTextShortcut,
  onExitFocusMode,
}: FocusModeBarProps) {
  const hasModifiers = useMemo(
    () => hasActiveTerminalModifiers(terminalModifiers),
    [terminalModifiers],
  );

  return (
    <div
      className="shrink-0 bg-[#1e1e1e] safe-area-bottom"
    >
      <div
        className="hide-scrollbar flex items-center gap-1 overflow-x-auto px-1.5 py-1.5"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {/* Exit focus mode */}
        <TouchControlButton
          variant="ghost"
          size="xs"
          className={`${btnClass} text-gray-300`}
          onClick={onExitFocusMode}
          aria-label="Exit focus mode"
          title="Exit focus mode"
        >
          ✕
        </TouchControlButton>

        <span className={separatorClass} aria-hidden="true" />

        {/* Modifier toggles */}
        <TouchControlButton
          variant={terminalModifiers.ctrl ? "primary" : "secondary"}
          size="xs"
          className={btnClass}
          aria-pressed={terminalModifiers.ctrl}
          onClick={() => toggleTerminalModifier("ctrl")}
        >
          ctrl
        </TouchControlButton>
        <TouchControlButton
          variant={terminalModifiers.alt ? "primary" : "secondary"}
          size="xs"
          className={btnClass}
          aria-pressed={terminalModifiers.alt}
          onClick={() => toggleTerminalModifier("alt")}
        >
          alt
        </TouchControlButton>
        <TouchControlButton
          variant={terminalModifiers.shift ? "primary" : "secondary"}
          size="xs"
          className={btnClass}
          aria-pressed={terminalModifiers.shift}
          onClick={() => toggleTerminalModifier("shift")}
        >
          shift
        </TouchControlButton>
        {hasModifiers && (
          <TouchControlButton
            variant="ghost"
            size="xs"
            className={`${btnClass} text-gray-400`}
            onClick={resetTerminalModifiers}
            aria-label="Clear modifiers"
            title="Clear modifiers"
          >
            ✕
          </TouchControlButton>
        )}

        <span className={separatorClass} aria-hidden="true" />

        {/* Special keys */}
        <TouchControlButton variant="secondary" size="xs" className={btnClass} onClick={() => sendEncodedTerminalKey("Escape")}>
          esc
        </TouchControlButton>
        <TouchControlButton variant="secondary" size="xs" className={btnClass} onClick={() => sendEncodedTerminalKey("Tab")}>
          tab
        </TouchControlButton>
        <TouchControlButton variant="secondary" size="xs" className={btnClass} aria-label="Enter" onClick={() => sendEncodedTerminalKey("Enter")}>
          ⏎
        </TouchControlButton>
        <TouchControlButton variant="secondary" size="xs" className={btnClass} aria-label="Backspace" onClick={() => sendEncodedTerminalKey("Backspace")}>
          ⌫
        </TouchControlButton>
        <TouchControlButton variant="secondary" size="xs" className={btnClass} aria-label="Space" onClick={() => sendEncodedTerminalKey("Space")}>
          ␣
        </TouchControlButton>

        <span className={separatorClass} aria-hidden="true" />

        {/* Arrow keys */}
        <TouchControlButton variant="secondary" size="xs" className={btnClass} aria-label="Arrow left" onClick={() => sendEncodedTerminalKey("ArrowLeft")}>
          ◀
        </TouchControlButton>
        <TouchControlButton variant="secondary" size="xs" className={btnClass} aria-label="Arrow up" onClick={() => sendEncodedTerminalKey("ArrowUp")}>
          ▲
        </TouchControlButton>
        <TouchControlButton variant="secondary" size="xs" className={btnClass} aria-label="Arrow down" onClick={() => sendEncodedTerminalKey("ArrowDown")}>
          ▼
        </TouchControlButton>
        <TouchControlButton variant="secondary" size="xs" className={btnClass} aria-label="Arrow right" onClick={() => sendEncodedTerminalKey("ArrowRight")}>
          ▶
        </TouchControlButton>

        <span className={separatorClass} aria-hidden="true" />

        {/* Actions */}
        <TouchControlButton variant="secondary" size="xs" className={btnClass} onClick={sendCtrlC}>
          ^C
        </TouchControlButton>
        <TouchControlButton
          variant="secondary"
          size="xs"
          className={btnClass}
          disabled={!hasSelectedTerminalText}
          onClick={copySelectedTerminalText}
        >
          Copy
        </TouchControlButton>

        <span className={separatorClass} aria-hidden="true" />

        {/* Shortcuts */}
        <TouchControlButton variant="secondary" size="xs" className={btnClass} onClick={() => sendTerminalTextShortcut("nvim\n")}>
          nvim
        </TouchControlButton>
        <TouchControlButton variant="secondary" size="xs" className={btnClass} onClick={() => sendTerminalTextShortcut(":Ntree\n")}>
          Ntree
        </TouchControlButton>
        <TouchControlButton variant="secondary" size="xs" className={btnClass} onClick={() => sendTerminalTextShortcut(":q\n")}>
          :q
        </TouchControlButton>
        <TouchControlButton variant="secondary" size="xs" className={btnClass} onClick={() => sendTerminalTextShortcut("fresh\n")}>
          fresh
        </TouchControlButton>
      </div>
    </div>
  );
}
