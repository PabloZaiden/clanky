/**
 * Event types for standalone SSH-server session lifecycle updates.
 */

import type { SshServerSession } from "./ssh-server";
import type { TerminalSessionStatus } from "./terminal-session";

export type SshServerSessionEvent =
  | SshServerSessionCreatedEvent
  | SshServerSessionUpdatedEvent
  | SshServerSessionDeletedEvent
  | SshServerSessionStatusEvent;

export interface SshServerSessionCreatedEvent {
  type: "ssh_server_session.created";
  sshServerSessionId: string;
  session: SshServerSession;
  timestamp: string;
}

export interface SshServerSessionUpdatedEvent {
  type: "ssh_server_session.updated";
  sshServerSessionId: string;
  session: SshServerSession;
  timestamp: string;
}

export interface SshServerSessionDeletedEvent {
  type: "ssh_server_session.deleted";
  sshServerSessionId: string;
  timestamp: string;
}

export interface SshServerSessionStatusEvent {
  type: "ssh_server_session.status";
  sshServerSessionId: string;
  status: TerminalSessionStatus;
  error?: string;
  timestamp: string;
}
