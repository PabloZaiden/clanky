/**
 * Types and interfaces for the SSH terminal bridge.
 */

export interface SshTerminalBridgeOptions {
  onOutput: (chunk: string) => void;
  onClipboardCopy?: (text: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (error: Error) => void;
  readyTimeoutMs?: number;
}

export interface SshTerminalBridgeConnectOptions {
  sessionKind?: "workspace" | "terminal" | "standalone";
  credentialToken?: string;
}

export interface ClipboardSequenceResult {
  visibleOutput: string;
  clipboardCopies: string[];
  remainder: string;
}
