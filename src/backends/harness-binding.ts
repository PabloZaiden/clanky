/**
 * Validates durable ownership at the native metadata boundary.
 */

import { HarnessConversationBindingSchema } from "@/contracts/schemas/harness";
import { executionHostBindingsEqual } from "@/shared/execution-host";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import { HarnessError } from "./harness-errors";

export function requireMatchingHarnessBinding(raw: string | undefined, expected: HarnessConversationBinding): void {
  try {
    const actual = HarnessConversationBindingSchema.parse(JSON.parse(raw ?? "null"));
    const hostMatches = actual.executionHost && expected.executionHost
      ? executionHostBindingsEqual(actual.executionHost, expected.executionHost)
      : actual.executionHost === undefined && expected.executionHost === undefined;
    if (
      actual.adapter !== expected.adapter || actual.nativeId !== expected.nativeId
      || actual.ownerId !== expected.ownerId || actual.contextId !== expected.contextId
      || actual.directory !== expected.directory || !hostMatches
      || (actual.questionPolicy !== undefined && actual.questionPolicy !== expected.questionPolicy)
    ) throw new Error("Native ownership binding mismatch.");
  } catch (error) {
    throw new HarnessError("harness_session_not_owned", "The native conversation has no matching Clanky ownership binding.", { cause: error });
  }
}
