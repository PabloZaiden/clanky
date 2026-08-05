import { describe, expect, test } from "bun:test";
import { pollUntil } from "../helpers/polling";

describe("pollUntil", () => {
  test("returns the first observation that satisfies the predicate", async () => {
    const result = await pollUntil(
      async () => "ready",
      (value) => value === "ready",
      {
        description: "the state to become ready",
        timeoutMs: 0,
        intervalMs: 0,
      },
    );

    expect(result).toBe("ready");
  });

  test("retries observations until the predicate succeeds", async () => {
    let attempts = 0;
    const result = await pollUntil(
      () => ++attempts,
      (value) => value === 3,
      {
        description: "the counter to reach three",
        timeoutMs: 1000,
        intervalMs: 0,
      },
    );

    expect(result).toBe(3);
    expect(attempts).toBe(3);
  });

  test("includes the last observed value in timeout errors", async () => {
    await expect(
      pollUntil(
        () => ({ status: "running" }),
        () => false,
        {
          description: "the task to complete",
          timeoutMs: 0,
          intervalMs: 0,
          formatLastObserved: (value) => `status=${value.status}`,
        },
      ),
    ).rejects.toThrow(
      "Timed out waiting for the task to complete within 0ms. Last observed: status=running",
    );
  });
});
