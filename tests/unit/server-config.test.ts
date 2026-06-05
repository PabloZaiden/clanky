import { describe, expect, test } from "bun:test";

import { DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS } from "../../src/core/server-config";

describe("server config", () => {
  test("sets Bun server idleTimeout default to disabled", () => {
    expect(DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS).toBe(0);
  });
});
