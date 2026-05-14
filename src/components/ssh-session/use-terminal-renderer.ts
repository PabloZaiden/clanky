/**
 * Hook for initializing and managing the Ghostty terminal renderer in the DOM.
 */

import { useEffect } from "react";
import type React from "react";
import { FitAddon, Terminal } from "ghostty-web";
import {
  initializeGhosttyWeb,
  remeasureTerminalFont,
  resolveTerminalFontFamily,
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_THEME,
} from "./terminal-constants";
import { installTerminalMouseHandlers } from "./terminal-mouse";

interface UseTerminalRendererParams {
  sessionConfigId: string | undefined;
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  terminalRef: React.MutableRefObject<Terminal | null>;
  fitAddonRef: React.MutableRefObject<FitAddon | null>;
  terminalReadyRef: React.MutableRefObject<boolean>;
  sendTerminalKeystroke: (data: string) => void;
  sendTerminalResize: (cols: number, rows: number) => void;
  sendTerminalInput: (data: string, options?: { focusTerminal?: boolean; notifyOnFailure?: boolean }) => boolean;
  syncTerminalSelectionState: () => void;
  syncTerminalSize: (options?: { fit?: boolean }) => void;
  flushPendingOutput: () => void;
  showErrorToast: (message: string) => void;
}

export function useTerminalRenderer({
  sessionConfigId,
  terminalContainerRef,
  terminalRef,
  fitAddonRef,
  terminalReadyRef,
  sendTerminalKeystroke,
  sendTerminalResize,
  sendTerminalInput,
  syncTerminalSelectionState,
  syncTerminalSize,
  flushPendingOutput,
  showErrorToast,
}: UseTerminalRendererParams): void {
  useEffect(() => {
    let disposed = false;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let dataDisposable: { dispose(): void } | null = null;
    let resizeDisposable: { dispose(): void } | null = null;
    let selectionDisposable: { dispose(): void } | null = null;
    let removeMouseHandlers: (() => void) | null = null;

    async function setupTerminal() {
      if (!terminalContainerRef.current || terminalRef.current) {
        return;
      }

      try {
        await initializeGhosttyWeb();
        if (disposed || !terminalContainerRef.current || terminalRef.current) {
          return;
        }
        const terminalFontFamily = await resolveTerminalFontFamily();
        if (disposed || !terminalContainerRef.current || terminalRef.current) {
          return;
        }

        terminal = new Terminal({
          fontSize: TERMINAL_FONT_SIZE_PX,
          fontFamily: terminalFontFamily,
          cursorBlink: true,
          cursorStyle: "block",
          theme: TERMINAL_THEME,
        });
        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(terminalContainerRef.current);
        fitAddon.observeResize();
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;
        syncTerminalSelectionState();
        flushPendingOutput();

        dataDisposable = terminal.onData((data: string) => {
          void sendTerminalKeystroke(data);
        });
        resizeDisposable = terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          sendTerminalResize(cols, rows);
        });
        selectionDisposable = terminal.onSelectionChange(() => {
          syncTerminalSelectionState();
        });
        terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
          if (event.key !== "Tab" || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
            return false;
          }
          void sendTerminalInput("\u001b[Z", { notifyOnFailure: false });
          return true;
        });
        removeMouseHandlers = installTerminalMouseHandlers({
          terminal,
          container: terminalContainerRef.current,
          sendInput: (data: string) => sendTerminalInput(data, { notifyOnFailure: false }),
        });

        syncTerminalSize({ fit: true });
        if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              if (!disposed && terminalRef.current === terminal) {
                syncTerminalSize({ fit: true });
              }
            });
          });
        }
        if (terminalReadyRef.current) {
          syncTerminalSize();
        }
        void remeasureTerminalFont(terminal, fitAddon);
      } catch (error) {
        if (!disposed) {
          showErrorToast(`Failed to initialize the terminal renderer: ${String(error)}`);
        }
      }
    }

    void setupTerminal();

    return () => {
      disposed = true;
      removeMouseHandlers?.();
      dataDisposable?.dispose();
      resizeDisposable?.dispose();
      selectionDisposable?.dispose();
      terminal?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    fitAddonRef,
    flushPendingOutput,
    sendTerminalInput,
    sendTerminalKeystroke,
    sendTerminalResize,
    sessionConfigId,
    syncTerminalSelectionState,
    showErrorToast,
    syncTerminalSize,
    terminalContainerRef,
    terminalReadyRef,
    terminalRef,
  ]);
}
