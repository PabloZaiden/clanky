/**
 * Tests for the loop state machine.
 * Verifies all valid transitions and rejects all invalid ones.
 */

import { test, expect, describe } from "bun:test";
import {
  isValidTransition,
  assertValidTransition,
  getValidTransitions,
  isTerminalStatus,
  isActiveStatus,
} from "../../src/core/loop-state-machine";
import type { LoopStatus } from "../../src/types/loop";

/**
 * All possible loop statuses.
 */
const ALL_STATUSES: LoopStatus[] = [
  "idle",
  "draft",
  "planning",
  "starting",
  "running",
  "waiting",
  "completed",
  "stopped",
  "failed",
  "max_iterations",
  "resolving_conflicts",
  "merged",
  "accepted_local",
  "pushed",
  "deleted",
];

/**
 * Expected valid transitions for each status.
 * This serves as the "test spec" — if this doesn't match the implementation,
 * the tests will catch it.
 */
const EXPECTED_TRANSITIONS: Record<LoopStatus, LoopStatus[]> = {
  idle: ["starting", "planning", "draft", "deleted"],
  draft: ["idle", "planning", "deleted"],
  planning: ["starting", "completed", "stopped", "failed", "deleted"],
  starting: ["running", "resolving_conflicts", "failed", "stopped", "deleted"],
  running: ["completed", "stopped", "failed", "max_iterations", "deleted"],
  waiting: ["running", "completed", "stopped", "failed", "max_iterations", "deleted"],
  completed: ["accepted_local", "pushed", "deleted", "resolving_conflicts", "starting", "idle", "stopped", "planning"],
  stopped: ["starting", "planning", "completed", "deleted", "stopped"],
  failed: ["completed", "deleted", "stopped", "planning"],
  max_iterations: ["accepted_local", "pushed", "deleted", "resolving_conflicts", "stopped", "planning"],
  resolving_conflicts: ["starting", "stopped", "failed", "pushed", "completed", "max_iterations", "deleted"],
  accepted_local: ["pushed", "deleted", "idle", "resolving_conflicts", "accepted_local"],
  merged: ["deleted"],
  pushed: ["merged", "deleted", "idle", "resolving_conflicts", "pushed", "starting"],
  deleted: ["stopped", "planning"],
};

describe("loop-state-machine", () => {
  describe("isValidTransition", () => {
    // Test every valid transition
    for (const [from, targets] of Object.entries(EXPECTED_TRANSITIONS)) {
      for (const to of targets) {
        test(`allows ${from} → ${to}`, () => {
          expect(isValidTransition(from as LoopStatus, to as LoopStatus)).toBe(true);
        });
      }
    }

    // Test that every transition NOT in the expected set is rejected
    for (const from of ALL_STATUSES) {
      const validTargets = new Set(EXPECTED_TRANSITIONS[from]);
      const invalidTargets = ALL_STATUSES.filter((s) => !validTargets.has(s));

      for (const to of invalidTargets) {
        test(`rejects ${from} → ${to}`, () => {
          expect(isValidTransition(from, to)).toBe(false);
        });
      }
    }
  });

  describe("assertValidTransition", () => {
    test("does not throw for valid transition", () => {
      expect(() => assertValidTransition("idle", "starting")).not.toThrow();
    });

    test("throws for invalid transition", () => {
      expect(() => assertValidTransition("deleted", "running")).toThrow(
        "Invalid loop status transition: deleted → running",
      );
    });

    test("includes context in error message when provided", () => {
      expect(() =>
        assertValidTransition("deleted", "running", "deleteLoop"),
      ).toThrow("Invalid loop status transition: deleted → running (deleteLoop)");
    });

    test("does not include context parentheses when context is omitted", () => {
      try {
        assertValidTransition("deleted", "running");
      } catch (error) {
        expect(String(error)).not.toContain("(");
      }
    });
  });

  describe("getValidTransitions", () => {
    test("returns correct transitions for idle", () => {
      const transitions = getValidTransitions("idle");
      expect(transitions.has("starting")).toBe(true);
      expect(transitions.has("planning")).toBe(true);
      expect(transitions.has("deleted")).toBe(true);
      expect(transitions.size).toBe(4);
    });

    test("returns restart transitions for deleted", () => {
      const transitions = getValidTransitions("deleted");
      expect(transitions.has("stopped")).toBe(true);
      expect(transitions.has("planning")).toBe(true);
      expect(transitions.size).toBe(2);
    });

    test("returns all expected transitions for each status", () => {
      for (const [status, expected] of Object.entries(EXPECTED_TRANSITIONS)) {
        const transitions = getValidTransitions(status as LoopStatus);
        expect(transitions.size).toBe(expected.length);
        for (const target of expected) {
          expect(transitions.has(target as LoopStatus)).toBe(true);
        }
      }
    });
  });

  describe("isTerminalStatus", () => {
    test("deleted is no longer terminal because it can be revived before purge", () => {
      expect(isTerminalStatus("deleted")).toBe(false);
    });

    test("other non-terminal statuses remain non-terminal", () => {
      const nonTerminal = ALL_STATUSES.filter((s) => s !== "deleted");
      for (const status of nonTerminal) {
        expect(isTerminalStatus(status)).toBe(false);
      }
    });
  });

  describe("isActiveStatus", () => {
    test("starting is active", () => {
      expect(isActiveStatus("starting")).toBe(true);
    });

    test("running is active", () => {
      expect(isActiveStatus("running")).toBe(true);
    });

    test("planning is active", () => {
      expect(isActiveStatus("planning")).toBe(true);
    });

    test("resolving_conflicts is active", () => {
      expect(isActiveStatus("resolving_conflicts")).toBe(true);
    });

    test("completed is not active", () => {
      expect(isActiveStatus("completed")).toBe(false);
    });

    test("stopped is not active", () => {
      expect(isActiveStatus("stopped")).toBe(false);
    });

    test("draft is not active", () => {
      expect(isActiveStatus("draft")).toBe(false);
    });

    test("deleted is not active", () => {
      expect(isActiveStatus("deleted")).toBe(false);
    });
  });

  describe("transition completeness", () => {
    test("all statuses have an entry in the transition table", () => {
      for (const status of ALL_STATUSES) {
        const transitions = getValidTransitions(status);
        // Just verifying it doesn't throw — the set is always returned
        expect(transitions).toBeDefined();
      }
    });

    test("all transition targets are valid statuses", () => {
      const statusSet = new Set(ALL_STATUSES);
      for (const status of ALL_STATUSES) {
        const transitions = getValidTransitions(status);
        for (const target of transitions) {
          expect(statusSet.has(target)).toBe(true);
        }
      }
    });

    test("no status can transition to itself except stopped and pushed", () => {
      const selfTransitionAllowed = new Set<LoopStatus>(["stopped", "accepted_local", "pushed"]);
      for (const status of ALL_STATUSES) {
        if (selfTransitionAllowed.has(status)) {
          // stopped → stopped: jumpstart re-enters stopped for restart
          // pushed → pushed: re-push after branch update (updateBranch)
          expect(isValidTransition(status, status)).toBe(true);
        } else {
          expect(isValidTransition(status, status)).toBe(false);
        }
      }
    });
  });
});
