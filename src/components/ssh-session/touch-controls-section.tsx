import { useMemo, useState } from "react";
import { Badge } from "../common";
import {
  hasActiveTerminalModifiers,
  type TerminalModifierState,
  type TerminalSpecialKey,
} from "../../utils/terminal-keys";
import { CompactBar } from "./compact-bar";
import { TouchControlButton } from "./touch-control-button";

const touchButtonClassName = "min-h-[28px] shrink-0 whitespace-nowrap px-1.5 py-0.5 text-[11px]";

export interface TouchControlsSectionProps {
  terminalModifiers: TerminalModifierState;
  hasSelectedTerminalText: boolean;
  toggleTerminalModifier: (modifier: keyof TerminalModifierState) => void;
  resetTerminalModifiers: () => void;
  copySelectedTerminalText: () => void;
  sendEncodedTerminalKey: (key: TerminalSpecialKey | string) => void;
  sendCtrlC: () => void;
  onEnterFocusMode?: () => void;
}

export function TouchControlsSection({
  terminalModifiers,
  hasSelectedTerminalText,
  toggleTerminalModifier,
  resetTerminalModifiers,
  copySelectedTerminalText,
  sendEncodedTerminalKey,
  sendCtrlC,
  onEnterFocusMode,
}: TouchControlsSectionProps) {
  const [expanded, setExpanded] = useState(false);

  const activeModifierLabel = useMemo(() => {
    return [
      terminalModifiers.ctrl ? "Ctrl" : null,
      terminalModifiers.alt ? "Alt" : null,
      terminalModifiers.shift ? "Shift" : null,
    ].filter(Boolean).join(" + ");
  }, [terminalModifiers]);

  const summary = useMemo(() => (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      {hasActiveTerminalModifiers(terminalModifiers) ? (
        <Badge variant="info" className="shrink-0">
          Next: {activeModifierLabel}
        </Badge>
      ) : (
        <Badge variant="default" className="shrink-0">
          Modifiers off
        </Badge>
      )}
      {onEnterFocusMode && (
        <TouchControlButton
          variant="ghost"
          size="xs"
          className="min-h-[24px] shrink-0 px-1.5 py-0 text-[11px]"
          onClick={(e) => {
            e.stopPropagation();
            onEnterFocusMode();
          }}
          aria-label="Enter focus mode"
          title="Focus mode — fullscreen terminal with compact controls"
        >
          ⛶
        </TouchControlButton>
      )}
      <span className="hidden min-w-0 break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere] sm:block">
        Touch keys
      </span>
    </div>
  ), [activeModifierLabel, terminalModifiers, onEnterFocusMode]);

  return (
    <CompactBar
      title="Touch controls"
      expanded={expanded}
      onToggle={() => setExpanded((current) => !current)}
      summary={summary}
    >
      <div className="flex flex-col gap-2">
        <div className="px-1 pb-1" data-testid="ssh-touch-controls-layout">
          <div className="flex flex-wrap items-center gap-1" data-testid="ssh-touch-controls-buttons">
            <TouchControlButton
              variant={terminalModifiers.ctrl ? "primary" : "secondary"}
              size="xs"
              className={touchButtonClassName}
              aria-pressed={terminalModifiers.ctrl}
              onClick={() => toggleTerminalModifier("ctrl")}
            >
              Ctrl
            </TouchControlButton>
            <TouchControlButton
              variant={terminalModifiers.alt ? "primary" : "secondary"}
              size="xs"
              className={touchButtonClassName}
              aria-pressed={terminalModifiers.alt}
              onClick={() => toggleTerminalModifier("alt")}
            >
              Alt
            </TouchControlButton>
            <TouchControlButton
              variant={terminalModifiers.shift ? "primary" : "secondary"}
              size="xs"
              className={touchButtonClassName}
              aria-pressed={terminalModifiers.shift}
              onClick={() => toggleTerminalModifier("shift")}
            >
              Shift
            </TouchControlButton>
            {hasActiveTerminalModifiers(terminalModifiers) && (
              <TouchControlButton
                variant="ghost"
                size="xs"
                className={touchButtonClassName}
                onClick={resetTerminalModifiers}
              >
                Clear
              </TouchControlButton>
            )}
            <span className="mx-0.5 h-4 w-px shrink-0 bg-gray-200 dark:bg-neutral-700" aria-hidden="true" />
            <TouchControlButton
              variant="secondary"
              size="xs"
              className={touchButtonClassName}
              onClick={() => sendEncodedTerminalKey("Escape")}
            >
              Esc
            </TouchControlButton>
            <TouchControlButton
              variant="secondary"
              size="xs"
              className={touchButtonClassName}
              onClick={() => sendEncodedTerminalKey("Tab")}
            >
              Tab
            </TouchControlButton>
            <TouchControlButton
              variant="secondary"
              size="xs"
              className={touchButtonClassName}
              onClick={() => sendEncodedTerminalKey("Enter")}
            >
              Enter
            </TouchControlButton>
            <TouchControlButton
              variant="secondary"
              size="xs"
              className={touchButtonClassName}
              aria-label="Backspace"
              onClick={() => sendEncodedTerminalKey("Backspace")}
            >
              Bksp
            </TouchControlButton>
            <TouchControlButton
              variant="secondary"
              size="xs"
              className={touchButtonClassName}
              onClick={() => sendEncodedTerminalKey("Space")}
            >
              Space
            </TouchControlButton>
            <TouchControlButton
              variant="secondary"
              size="xs"
              className={touchButtonClassName}
              onClick={sendCtrlC}
            >
              Ctrl+C
            </TouchControlButton>
            <TouchControlButton
              variant="secondary"
              size="xs"
              className={touchButtonClassName}
              onClick={() => sendEncodedTerminalKey("ArrowUp")}
            >
              ↑
            </TouchControlButton>
            <TouchControlButton
              variant="secondary"
              size="xs"
              className={touchButtonClassName}
              onClick={() => sendEncodedTerminalKey("ArrowLeft")}
            >
              ←
            </TouchControlButton>
            <TouchControlButton
              variant="secondary"
              size="xs"
              className={touchButtonClassName}
              onClick={() => sendEncodedTerminalKey("ArrowDown")}
            >
              ↓
            </TouchControlButton>
            <TouchControlButton
              variant="secondary"
              size="xs"
              className={touchButtonClassName}
              onClick={() => sendEncodedTerminalKey("ArrowRight")}
            >
              →
            </TouchControlButton>
            <span className="mx-0.5 h-4 w-px shrink-0 bg-gray-200 dark:bg-neutral-700" aria-hidden="true" />
            <TouchControlButton
              variant="secondary"
              size="xs"
              className={touchButtonClassName}
              disabled={!hasSelectedTerminalText}
              onClick={copySelectedTerminalText}
            >
              Copy selection
            </TouchControlButton>
          </div>
        </div>
      </div>
    </CompactBar>
  );
}
