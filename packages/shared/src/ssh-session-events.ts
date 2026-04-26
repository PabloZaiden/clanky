/**
 * Event types for SSH session lifecycle updates.
 */

import type { PortForward, PortForwardStatus, SshSession, SshSessionStatus } from "./ssh-session";

export type SshSessionEvent =
  | SshSessionCreatedEvent
  | SshSessionUpdatedEvent
  | SshSessionDeletedEvent
  | SshSessionStatusEvent
  | PortForwardCreatedEvent
  | PortForwardUpdatedEvent
  | PortForwardDeletedEvent
  | PortForwardStatusEvent;

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

export interface PortForwardCreatedEvent {
  type: "ssh_session.port_forward.created";
  portForwardId: string;
  loopId: string;
  sshSessionId?: string;
  forward: PortForward;
  timestamp: string;
}

export interface PortForwardUpdatedEvent {
  type: "ssh_session.port_forward.updated";
  portForwardId: string;
  loopId: string;
  sshSessionId?: string;
  forward: PortForward;
  timestamp: string;
}

export interface PortForwardDeletedEvent {
  type: "ssh_session.port_forward.deleted";
  portForwardId: string;
  loopId: string;
  sshSessionId?: string;
  timestamp: string;
}

export interface PortForwardStatusEvent {
  type: "ssh_session.port_forward.status";
  portForwardId: string;
  loopId: string;
  sshSessionId?: string;
  status: PortForwardStatus;
  error?: string;
  timestamp: string;
}
