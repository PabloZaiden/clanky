/**
 * Event types for SSH session lifecycle updates.
 */

import type { SshSession, SshSessionStatus } from "./ssh-session";

export type SshSessionEvent =
  | SshSessionCreatedEvent
  | SshSessionUpdatedEvent
  | SshSessionDeletedEvent
  | SshSessionStatusEvent;

export interface SshSessionCreatedEvent {
  type: "ssh_session.created";
  sshSessionId: string;
  session: SshSession;
  timestamp: string;
}

export interface SshSessionUpdatedEvent {
  type: "ssh_session.updated";
  sshSessionId: string;
  session: SshSession;
  timestamp: string;
}

export interface SshSessionDeletedEvent {
  type: "ssh_session.deleted";
  sshSessionId: string;
  timestamp: string;
}

export interface SshSessionStatusEvent {
  type: "ssh_session.status";
  sshSessionId: string;
  status: SshSessionStatus;
  error?: string;
  timestamp: string;
}
