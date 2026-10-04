/**
 * Session-lifetime observation and control contracts for owned harness work.
 */

import type { HarnessNativeReferences } from "./harness-events";
import type { PromptInput } from "./harness-input";
import type { ExecutionHostBinding } from "./execution-host";
import type { HarnessQuestionRequest } from "./harness-questions";

export type HarnessQuestionPolicy = "interactive" | "unattended";

export interface HarnessConversationBinding {
  adapter: HarnessNativeReferences["adapter"];
  nativeId: string;
  ownerId: string;
  contextId: string;
  directory: string;
  executionHost?: ExecutionHostBinding;
  questionPolicy?: HarnessQuestionPolicy;
}

export interface HarnessCapabilities {
  adapter: HarnessNativeReferences["adapter"];
  experimental: boolean;
  steering: "unsupported" | "active-session" | "expected-turn";
  activity: "unavailable" | "partial" | "native";
  stopScopes: readonly ("child-execution" | "command")[];
  questionPolicy?: "session";
}

export interface HarnessActivity {
  id: string;
  parentId?: string;
  spawningToolCallId?: string;
  kind: "subagent" | "process" | "external";
  description: string;
  status: "queued" | "running" | "waiting" | "idle" | "stopping" | "stopped" | "completed" | "failed" | "unknown";
  ownership: "owned" | "unverified";
  workspaceWrites: "possible" | "none" | "unknown";
  native: HarnessNativeReferences;
  requestedModel?: string;
  effectiveModel?: string;
  lastActivity?: string;
}

export type HarnessActivitySnapshot =
  | {
      observation: "available";
      coverage: "partial" | "native";
      observedAt: string;
      principalProcessing: boolean;
      activities: HarnessActivity[];
    }
  | {
      observation: "unavailable";
      reason: "unsupported" | "disconnected" | "gap";
    };

export interface HarnessSteerRequest {
  inputId: string;
  prompt: PromptInput;
  expectedTurnId?: string;
}

export type HarnessInputAdmission =
  | {
      status: "accepted" | "delivered";
      inputId: string;
      nativeTurnId?: string;
    } & (
      | { nativeMessageId: string; nativeClientInputId?: string }
      | { nativeMessageId?: string; nativeClientInputId: string }
    )
  | { status: "rejected"; inputId: string; code: "not-running" | "turn-changed" | "unsupported" }
  | { status: "unknown"; inputId: string };

export interface HarnessInputRecoveryRequest {
  inputId: string;
  nativeMessageId?: string;
  nativeClientInputId?: string;
  nativeTurnId?: string;
}

export interface HarnessInputReceipt {
  conversation: HarnessConversationBinding;
  admission: HarnessInputAdmission;
  submittedAt: string;
}

export interface HarnessConversationState {
  capabilities?: HarnessCapabilities;
  activity?: HarnessActivitySnapshot;
  cleanup?: HarnessCleanupResult;
  gitSafety?: HarnessGitSafety;
  gitOutcome?: { status: "pending" | "succeeded" | "failed"; observedAt: string };
  inputs?: HarnessInputReceipt[];
  integrity?: "invalid";
  questions?: HarnessQuestionRequest[];
}

export type HarnessGitSafety =
  | { status: "safe"; observedAt: string }
  | { status: "blocked"; reason: "active-writers" | "unavailable"; activityIds: string[] };

export type HarnessActivityStopResult =
  | { status: "stopped"; activityId: string }
  | { status: "stopping" | "unknown"; activityId: string };

export type HarnessCleanupResult =
  | { status: "settled"; observedAt: string }
  | { status: "pending"; activityIds: string[] }
  | { status: "unavailable"; reason: "unsupported" | "disconnected" | "gap" };

export interface HarnessControl {
  readonly capabilities: HarnessCapabilities;
  getActivity(sessionId: string): Promise<HarnessActivitySnapshot>;
  stopActivity(sessionId: string, activityId: string): Promise<HarnessActivityStopResult>;
  /** Unsupported/model-validation errors are pre-admission; uncertain RPC outcomes return unknown. */
  steer(sessionId: string, request: HarnessSteerRequest): Promise<HarnessInputAdmission>;
  reconcileInput(sessionId: string, request: HarnessInputRecoveryRequest): Promise<HarnessInputAdmission>;
  settleOwnedWork(sessionId: string): Promise<HarnessCleanupResult>;
}
