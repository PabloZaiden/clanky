/**
 * Event types for workspace terminal session lifecycle updates.
 */

import type { TerminalSession, TerminalSessionStatus } from "./terminal-session";

export type TerminalSessionEvent =
  | TerminalSessionCreatedEvent
  | TerminalSessionUpdatedEvent
  | TerminalSessionDeletedEvent
  | TerminalSessionStatusEvent;

export interface TerminalSessionCreatedEvent {
  type: "terminal_session.created";
  terminalSessionId: string;
  session: TerminalSession;
  timestamp: string;
}

export interface TerminalSessionUpdatedEvent {
  type: "terminal_session.updated";
  terminalSessionId: string;
  session: TerminalSession;
  timestamp: string;
}

export interface TerminalSessionDeletedEvent {
  type: "terminal_session.deleted";
  terminalSessionId: string;
  timestamp: string;
}

export interface TerminalSessionStatusEvent {
  type: "terminal_session.status";
  terminalSessionId: string;
  status: TerminalSessionStatus;
  error?: string;
  timestamp: string;
}
