/**
 * Transport evidence for observed commands, distinct from workflow status.
 */
export const COMMAND_EXECUTION_STATES = [
  "not_started", "dispatched", "started", "finished",
] as const;

export type CommandExecutionState = typeof COMMAND_EXECUTION_STATES[number];
