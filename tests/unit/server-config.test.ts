import { describe, expect, test } from "bun:test";

import { DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS } from "../../src/core/server-config";

describe("server config", () => {
  test("does not impose a default idle timeout on long downloads", () => {
    expect(DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS).toBe(0);
  });
});
