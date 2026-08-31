/**
 * Owns active workspace-terminal attachments independently of WebSocket
 * transport details so lifecycle operations can close them before deletion.
 */

import { DomainError } from "./domain-error";
interface DisposableTerminalConnection {
  dispose(): Promise<void>;
}

interface WorkspaceTerminalAttachment {
  connection: DisposableTerminalConnection;
}

export interface WorkspaceTerminalAttachmentHandle {
  isActive(): boolean;
  release(): void;
}

const activeAttachments = new Map<string, WorkspaceTerminalAttachment>();
const blockedSessions = new Set<string>();

export async function claimWorkspaceTerminalAttachment(
  sessionId: string,
  connection: DisposableTerminalConnection,
): Promise<WorkspaceTerminalAttachmentHandle> {
  if (blockedSessions.has(sessionId)) {
    throw new DomainError(
      "terminal_session_closing",
      "The terminal session is being deleted.",
      { details: { terminalSessionId: sessionId } },
    );
  }

  const attachment: WorkspaceTerminalAttachment = {
    connection,
  };
  const previous = activeAttachments.get(sessionId);
  activeAttachments.set(sessionId, attachment);
  if (previous) {
    await previous.connection.dispose();
  }

  if (
    blockedSessions.has(sessionId)
    || activeAttachments.get(sessionId) !== attachment
  ) {
    if (activeAttachments.get(sessionId) === attachment) {
      activeAttachments.delete(sessionId);
    }
    await connection.dispose();
    throw new DomainError(
      "terminal_session_closing",
      "The terminal session is no longer available.",
      { details: { terminalSessionId: sessionId } },
    );
  }

  return {
    isActive: () => activeAttachments.get(sessionId) === attachment,
    release: () => {
      if (activeAttachments.get(sessionId) === attachment) {
        activeAttachments.delete(sessionId);
      }
    },
  };
}

export async function blockAndCloseWorkspaceTerminalAttachment(sessionId: string): Promise<void> {
  blockedSessions.add(sessionId);
  const attachment = activeAttachments.get(sessionId);
  if (!attachment) {
    return;
  }
  activeAttachments.delete(sessionId);
  await attachment.connection.dispose();
}

export function unblockWorkspaceTerminalAttachment(sessionId: string): void {
  blockedSessions.delete(sessionId);
}

export function isWorkspaceTerminalAttachmentBlocked(sessionId: string): boolean {
  return blockedSessions.has(sessionId);
}
