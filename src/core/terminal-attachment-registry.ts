/**
 * Owns active terminal attachments independently of WebSocket
 * transport details so lifecycle operations can close them before deletion.
 */

import { DomainError } from "./domain-error";
interface DisposableTerminalConnection {
  dispose(): Promise<void>;
}

interface TerminalAttachment {
  connection: DisposableTerminalConnection;
}

export interface TerminalAttachmentHandle {
  isActive(): boolean;
  release(): void;
}

const activeAttachments = new Map<string, TerminalAttachment>();
const blockedSessions = new Set<string>();

export async function claimTerminalAttachment(
  sessionId: string,
  connection: DisposableTerminalConnection,
): Promise<TerminalAttachmentHandle> {
  if (blockedSessions.has(sessionId)) {
    throw new DomainError(
      "terminal_session_closing",
      "The terminal session is being deleted.",
      { details: { terminalSessionId: sessionId } },
    );
  }

  const attachment: TerminalAttachment = {
    connection,
  };
  const previous = activeAttachments.get(sessionId);
  activeAttachments.set(sessionId, attachment);
  if (previous) {
    try {
      await previous.connection.dispose();
    } catch (error) {
      if (activeAttachments.get(sessionId) === attachment) {
        activeAttachments.set(sessionId, previous);
      }
      try {
        await connection.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Failed to replace the existing terminal attachment.",
        );
      }
      throw error;
    }
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

export async function blockAndCloseTerminalAttachment(sessionId: string): Promise<void> {
  blockedSessions.add(sessionId);
  const attachment = activeAttachments.get(sessionId);
  if (!attachment) {
    return;
  }
  activeAttachments.delete(sessionId);
  await attachment.connection.dispose();
}

export function unblockTerminalAttachment(sessionId: string): void {
  blockedSessions.delete(sessionId);
}

export function isTerminalAttachmentBlocked(sessionId: string): boolean {
  return blockedSessions.has(sessionId);
}
