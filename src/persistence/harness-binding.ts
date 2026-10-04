/**
 * Preserves malformed durable identities as unusable rather than legacy IDs.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { HarnessConversationBindingSchema, HarnessConversationStateSchema } from "@/contracts/schemas/harness";
import type { HarnessConversationBinding, HarnessConversationState } from "@/shared/harness-control";

const log = createLogger("persistence:harness-binding");

export function parseStoredHarnessBinding(raw: unknown, contextId: string): HarnessConversationBinding | null | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    if (typeof raw !== "string") throw new Error("Stored binding must be JSON.");
    return HarnessConversationBindingSchema.parse(JSON.parse(raw));
  } catch (error) {
    log.warn("Stored harness ownership is invalid", { contextId, error: String(error) });
    return null;
  }
}

export function parseStoredHarnessState(raw: unknown, contextId: string): HarnessConversationState | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    if (typeof raw !== "string") throw new Error("Stored harness state must be JSON.");
    return HarnessConversationStateSchema.parse(JSON.parse(raw));
  } catch (error) {
    log.warn("Stored harness state is invalid", { contextId, error: String(error) });
    return { integrity: "invalid", activity: { observation: "unavailable", reason: "gap" } };
  }
}
