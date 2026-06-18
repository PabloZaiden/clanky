import { describe, expect, test } from "bun:test";
import { calculateNextRunAt } from "../../src/core/agent-schedule";

describe("agent schedule calculations", () => {
  test("advances old minute schedules arithmetically", () => {
    const nextRunAt = calculateNextRunAt({
      startAtLocal: "2020-01-01T00:00",
      timezone: "UTC",
      interval: {
        value: 1,
        unit: "minutes",
      },
    }, new Date("2026-01-01T00:00:00Z"));

    expect(nextRunAt).toBe("2026-01-01T00:01:00.000Z");
  });

  test("advances old hour schedules arithmetically", () => {
    const nextRunAt = calculateNextRunAt({
      startAtLocal: "2020-01-01T00:00",
      timezone: "UTC",
      interval: {
        value: 1,
        unit: "hours",
      },
    }, new Date("2026-01-01T00:00:00Z"));

    expect(nextRunAt).toBe("2026-01-01T01:00:00.000Z");
  });

  test("advances old day schedules using local calendar days across DST", () => {
    const nextRunAt = calculateNextRunAt({
      startAtLocal: "2020-03-07T09:30",
      timezone: "America/New_York",
      interval: {
        value: 1,
        unit: "days",
      },
    }, new Date("2026-03-08T13:29:00Z"));

    expect(nextRunAt).toBe("2026-03-08T13:30:00.000Z");
  });
});
