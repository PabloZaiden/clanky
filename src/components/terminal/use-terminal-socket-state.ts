/**
 * Core refs and status state for a terminal WebSocket connection.
 */

import { useRef, useState } from "react";

export interface TerminalSocketState {
  socketStatus: "connecting" | "open" | "closed";
  setSocketStatus: (status: "connecting" | "open" | "closed") => void;
  terminalSocketRef: React.MutableRefObject<WebSocket | null>;
  terminalReadyRef: React.MutableRefObject<boolean>;
  pendingOutputRef: React.MutableRefObject<string[]>;
  pendingOscColorQueryRef: React.MutableRefObject<string>;
  lastSentResizeRef: React.MutableRefObject<{ cols: number; rows: number } | null>;
  terminalConnectInFlightRef: React.MutableRefObject<boolean>;
  standaloneTokenRecoveryAttemptedRef: React.MutableRefObject<boolean>;
}

export function useTerminalSocketState(): TerminalSocketState {
  const [socketStatus, setSocketStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const terminalSocketRef = useRef<WebSocket | null>(null);
  const terminalReadyRef = useRef(false);
  const pendingOutputRef = useRef<string[]>([]);
  const pendingOscColorQueryRef = useRef("");
  const lastSentResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const terminalConnectInFlightRef = useRef(false);
  const standaloneTokenRecoveryAttemptedRef = useRef(false);

  return {
    socketStatus,
    setSocketStatus,
    terminalSocketRef,
    terminalReadyRef,
    pendingOutputRef,
    pendingOscColorQueryRef,
    lastSentResizeRef,
    terminalConnectInFlightRef,
    standaloneTokenRecoveryAttemptedRef,
  };
}
