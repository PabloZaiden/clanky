/**
 * Tests for server runtime configuration helpers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getServerDevelopmentConfig,
  getServerRuntimeConfig,
  getServerStartupMessages,
} from "../../src/core/server-config";

const originalHost = process.env["CLANKY_HOST"];
const originalPort = process.env["CLANKY_PORT"];
const originalSameOriginDisabled = process.env["CLANKY_DISABLE_SAME_ORIGIN_CHECK"];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  restoreEnv("CLANKY_HOST", originalHost);
  restoreEnv("CLANKY_PORT", originalPort);
  restoreEnv("CLANKY_DISABLE_SAME_ORIGIN_CHECK", originalSameOriginDisabled);
});

describe("getServerRuntimeConfig", () => {
  beforeEach(() => {
    delete process.env["CLANKY_HOST"];
    delete process.env["CLANKY_PORT"];
    delete process.env["CLANKY_DISABLE_SAME_ORIGIN_CHECK"];
  });

  test("returns defaults when host env vars are unset", () => {
    expect(getServerRuntimeConfig()).toEqual({
      host: "127.0.0.1",
      port: 3000,
      hostSource: "default",
      sameOriginProtection: {
        disabled: false,
      },
    });
  });

  test("uses trimmed env values for host and port", () => {
    process.env["CLANKY_HOST"] = " 127.0.0.1 ";
    process.env["CLANKY_PORT"] = "8123";

    expect(getServerRuntimeConfig()).toEqual({
      host: "127.0.0.1",
      port: 8123,
      hostSource: "CLANKY_HOST",
      sameOriginProtection: {
        disabled: false,
      },
    });
  });

  test("falls back to the default port when CLANKY_PORT is blank after trimming", () => {
    process.env["CLANKY_PORT"] = "   ";

    expect(getServerRuntimeConfig().port).toBe(3000);
  });

  test("enables the same-origin bypass when the env var is truthy", () => {
    process.env["CLANKY_DISABLE_SAME_ORIGIN_CHECK"] = "yes";

    expect(getServerRuntimeConfig().sameOriginProtection).toEqual({
      disabled: true,
    });
  });

  test("throws a clear error for non-numeric ports", () => {
    process.env["CLANKY_PORT"] = "abc";

    expect(() => getServerRuntimeConfig()).toThrow(
      "CLANKY_PORT must be an integer between 0 and 65535; received \"abc\".",
    );
  });

  test("throws a clear error for out-of-range ports", () => {
    process.env["CLANKY_PORT"] = "70000";

    expect(() => getServerRuntimeConfig()).toThrow(
      "CLANKY_PORT must be an integer between 0 and 65535; received \"70000\".",
    );
  });
});

describe("getServerDevelopmentConfig", () => {
  test("enables Bun development helpers outside production", () => {
    expect(getServerDevelopmentConfig("development")).toEqual({
      hmr: true,
      console: true,
    });
    expect(getServerDevelopmentConfig(undefined)).toEqual({
      hmr: true,
      console: true,
    });
  });

  test("disables Bun development helpers in production", () => {
    expect(getServerDevelopmentConfig("production")).toBe(false);
  });
});

describe("getServerStartupMessages", () => {
  beforeEach(() => {
    delete process.env["CLANKY_HOST"];
    delete process.env["CLANKY_DISABLE_SAME_ORIGIN_CHECK"];
  });

  test("describes default host binding", () => {
    const messages = getServerStartupMessages(getServerRuntimeConfig());

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("CLANKY_HOST");
    expect(messages[0]).toContain("127.0.0.1");
    expect(messages[0]).toContain("0.0.0.0");
  });

  test("describes when same-origin protection is disabled", () => {
    process.env["CLANKY_DISABLE_SAME_ORIGIN_CHECK"] = "true";

    const messages = getServerStartupMessages(getServerRuntimeConfig());

    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain("CLANKY_DISABLE_SAME_ORIGIN_CHECK");
    expect(messages[1]).toContain("development");
    expect(messages[1]).toContain("disabled");
  });
});
