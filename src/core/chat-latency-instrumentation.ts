/**
 * Bounded timing helpers for chat creation and first-message startup.
 */

export type ChatLatencyStage =
  | "workspace_lookup"
  | "name_stats"
  | "worktree_preparation"
  | "chat_persistence"
  | "message_persistence"
  | "backend_connection"
  | "session_creation"
  | "model_configuration"
  | "prompt_start"
  | "name_generation";

export interface ChatLatencySnapshot {
  totalMs: number;
  stages: Partial<Record<ChatLatencyStage, number>>;
}

export interface ChatLatencyTimer {
  measure<T>(stage: ChatLatencyStage, operation: () => Promise<T>): Promise<T>;
  complete(): ChatLatencySnapshot;
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function createChatLatencyTimer(): ChatLatencyTimer {
  const startedAt = performance.now();
  const stages: Partial<Record<ChatLatencyStage, number>> = {};

  return {
    async measure<T>(stage: ChatLatencyStage, operation: () => Promise<T>): Promise<T> {
      const stageStartedAt = performance.now();
      try {
        return await operation();
      } finally {
        stages[stage] = elapsedMilliseconds(stageStartedAt);
      }
    },
    complete(): ChatLatencySnapshot {
      return {
        totalMs: elapsedMilliseconds(startedAt),
        stages: { ...stages },
      };
    },
  };
}
