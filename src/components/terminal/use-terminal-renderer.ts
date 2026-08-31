/**
 * Hook for initializing and managing the xterm.js terminal renderer in the DOM.
 */

import { useEffect } from "react";
import type React from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  refreshTerminalFont,
  resolveTerminalFontFamily,
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_THEME,
} from "./terminal-constants";

const log = createLogger("terminal-renderer");

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
    let webglAddon: WebglAddon | null = null;
    let webglContextLossDisposable: IDisposable | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let removeResizeListener: (() => void) | null = null;
    let resizeAnimationFrame: number | null = null;

    function queueFit() {
      if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
        syncTerminalSize({ fit: true });
        return;
      }
      if (resizeAnimationFrame !== null) {
        window.cancelAnimationFrame(resizeAnimationFrame);
      }
      resizeAnimationFrame = window.requestAnimationFrame(() => {
        resizeAnimationFrame = null;
        if (!disposed && terminalRef.current === terminal) {
          syncTerminalSize({ fit: true });
        }
      });
    }

    function loadWebglRenderer(nextTerminal: Terminal) {
      if (typeof WebGL2RenderingContext === "undefined") {
        return;
      }
      try {
        webglAddon = new WebglAddon();
        webglContextLossDisposable = webglAddon.onContextLoss(() => {
          webglAddon?.dispose();
          webglAddon = null;
        });
        nextTerminal.loadAddon(webglAddon);
      } catch (error) {
        log.warn(`Terminal WebGL renderer unavailable, using default renderer: ${String(error)}`);
        webglContextLossDisposable?.dispose();
        webglContextLossDisposable = null;
        webglAddon?.dispose();
        webglAddon = null;
      }
    }

    async function setupTerminal() {
      if (!terminalContainerRef.current || terminalRef.current) {
        return;
      }

      try {
        const terminalFontFamily = await resolveTerminalFontFamily();
        if (disposed || !terminalContainerRef.current || terminalRef.current) {
          return;
        }

        terminal = new Terminal({
          fontSize: TERMINAL_FONT_SIZE_PX,
          fontFamily: terminalFontFamily,
          theme: TERMINAL_THEME,
          scrollback: TERMINAL_SCROLLBACK_LINES,
          cursorBlink: true,
          cursorStyle: "block",
        });
        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(terminalContainerRef.current);
        loadWebglRenderer(terminal);
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;
        syncTerminalSelectionState();
        flushPendingOutput();
        terminal.focus();

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
          if (
            event.type !== "keydown"
            || event.key !== "Tab"
            || !event.shiftKey
            || event.ctrlKey
            || event.altKey
            || event.metaKey
          ) {
            return true;
          }
          void sendTerminalInput("\u001b[Z", { notifyOnFailure: false });
          return false;
        });
        if (typeof ResizeObserver === "undefined") {
          window.addEventListener("resize", queueFit);
          removeResizeListener = () => window.removeEventListener("resize", queueFit);
        } else {
          resizeObserver = new ResizeObserver(queueFit);
          resizeObserver.observe(terminalContainerRef.current);
        }

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
        void refreshTerminalFont(terminal, fitAddon);
      } catch (error) {
        if (!disposed) {
          showErrorToast(`Failed to initialize the terminal renderer: ${String(error)}`);
        }
      }
    }

    void setupTerminal();

    return () => {
      disposed = true;
      if (resizeAnimationFrame !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(resizeAnimationFrame);
      }
      resizeObserver?.disconnect();
      removeResizeListener?.();
      webglContextLossDisposable?.dispose();
      webglAddon?.dispose();
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
