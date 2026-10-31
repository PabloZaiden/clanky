/**
 * Shared terminal readiness and output constants.
 */

export const SESSION_READY_POLL_INTERVAL_MS = 100;
export const DEFAULT_SESSION_READY_TIMEOUT_MS = 15_000;
export const DEFAULT_TERMINAL_COMMAND_TIMEOUT_MS = 10_000;
export const OSC_52_SEQUENCE_START = "\u001b]52;";
export const OSC_SEQUENCE_BELL = "\u0007";
export const OSC_SEQUENCE_STRING_TERMINATOR = "\u001b\\";
export const MAX_PENDING_OSC_SEQUENCE_BYTES = 1024 * 1024;
