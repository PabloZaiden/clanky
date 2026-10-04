/**
 * Authorizes persisted identities before any adapter attempts native recovery.
 */

import type { AgentSession, Backend, CreateSessionOptions } from "../backends/types";
import { requireMatchingHarnessBinding } from "../backends/harness-binding";
import { HarnessError } from "../backends/harness-errors";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import type { SessionInfo } from "@/shared/task";
import { requireCurrentUserId } from "../context/user-context";

type SessionContext = Omit<HarnessConversationBinding, "adapter" | "nativeId">;

export function createTransientHarnessSession(
  backend: Pick<Backend, "harness" | "createSession">,
  options: CreateSessionOptions,
): Promise<AgentSession> {
  return createOwnedHarnessSession(backend, options, {
    ownerId: requireCurrentUserId(), contextId: `helper-${crypto.randomUUID()}`, directory: options.directory,
    questionPolicy: "unattended",
  });
}

export async function cleanupTransientHarnessSession(backend: Pick<Backend, "harness" | "abortSession" | "deleteSession">, sessionId: string): Promise<void> {
  if (backend.harness.capabilities.adapter === "acp") {
    await backend.abortSession(sessionId);
    return;
  }
  const result = await backend.harness.settleOwnedWork(sessionId);
  if (result.status !== "settled") throw new HarnessError("harness_request_failed", "Temporary native work did not settle.");
  await backend.deleteSession(sessionId);
}

export async function createOwnedHarnessSession(
  backend: Pick<Backend, "harness" | "createSession">,
  options: CreateSessionOptions,
  context: SessionContext,
): Promise<AgentSession> {
  const session = await backend.createSession({ ...options, directory: context.directory, ownership: context });
  const binding: HarnessConversationBinding = { ...context, adapter: backend.harness.capabilities.adapter, nativeId: session.id };
  if (session.binding) requireMatchingHarnessBinding(JSON.stringify(session.binding), binding);
  else if (binding.adapter !== "acp") throw new HarnessError("harness_session_not_owned", "The native adapter did not return an owned conversation.");
  return { ...session, binding };
}

export async function resumeOwnedHarnessSession(
  backend: Pick<Backend, "harness" | "resumeSession" | "getSession">,
  stored: SessionInfo,
  context: SessionContext,
): Promise<AgentSession | null> {
  const expected: HarnessConversationBinding = { ...context, adapter: backend.harness.capabilities.adapter, nativeId: stored.id };
  if (stored.binding === undefined && expected.adapter === "acp") {
    const session = await backend.getSession(stored.id);
    if (session && session.id !== stored.id) throw new HarnessError("harness_session_not_owned", "The legacy ACP conversation identity changed.");
    return session ? { ...session, binding: expected } : null;
  }
  requireMatchingHarnessBinding(JSON.stringify(stored.binding), expected);
  const session = await backend.resumeSession(expected);
  if (!session) return null;
  if (session.id !== stored.id || !session.binding) {
    throw new HarnessError("harness_session_not_owned", "Native recovery changed the owned conversation identity.");
  }
  requireMatchingHarnessBinding(JSON.stringify(session.binding), expected);
  return session;
}
