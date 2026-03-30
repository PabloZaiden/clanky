/**
 * Tests for application configuration helpers.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { isRemoteOnlyMode, isMockAcpEnabled, getAppConfig } from "../../src/core/config";

describe("isRemoteOnlyMode", () => {
  const originalEnv = process.env["RALPHER_REMOTE_ONLY"];

  afterEach(() => {
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env["RALPHER_REMOTE_ONLY"];
    } else {
      process.env["RALPHER_REMOTE_ONLY"] = originalEnv;
    }
  });

  test("returns false when env var is not set", () => {
    delete process.env["RALPHER_REMOTE_ONLY"];
    expect(isRemoteOnlyMode()).toBe(false);
  });

  test("returns false when env var is empty string", () => {
    process.env["RALPHER_REMOTE_ONLY"] = "";
    expect(isRemoteOnlyMode()).toBe(false);
  });

  test("returns false when env var is 'false'", () => {
    process.env["RALPHER_REMOTE_ONLY"] = "false";
    expect(isRemoteOnlyMode()).toBe(false);
  });

  test("returns false when env var is '0'", () => {
    // Note: '0' is actually not a truthy value in our implementation
    // We only accept 'true', '1', and 'yes'
    process.env["RALPHER_REMOTE_ONLY"] = "0";
    expect(isRemoteOnlyMode()).toBe(false);
  });

  test("returns true when env var is 'true'", () => {
    process.env["RALPHER_REMOTE_ONLY"] = "true";
    expect(isRemoteOnlyMode()).toBe(true);
  });

  test("returns true when env var is 'TRUE' (case insensitive)", () => {
    process.env["RALPHER_REMOTE_ONLY"] = "TRUE";
    expect(isRemoteOnlyMode()).toBe(true);
  });

  test("returns true when env var is 'True' (case insensitive)", () => {
    process.env["RALPHER_REMOTE_ONLY"] = "True";
    expect(isRemoteOnlyMode()).toBe(true);
  });

  test("returns true when env var is '1'", () => {
    process.env["RALPHER_REMOTE_ONLY"] = "1";
    expect(isRemoteOnlyMode()).toBe(true);
  });

  test("returns true when env var is 'yes'", () => {
    process.env["RALPHER_REMOTE_ONLY"] = "yes";
    expect(isRemoteOnlyMode()).toBe(true);
  });

  test("returns true when env var is 'YES' (case insensitive)", () => {
    process.env["RALPHER_REMOTE_ONLY"] = "YES";
    expect(isRemoteOnlyMode()).toBe(true);
  });

  test("returns false for other values", () => {
    process.env["RALPHER_REMOTE_ONLY"] = "no";
    expect(isRemoteOnlyMode()).toBe(false);

    process.env["RALPHER_REMOTE_ONLY"] = "enabled";
    expect(isRemoteOnlyMode()).toBe(false);

    process.env["RALPHER_REMOTE_ONLY"] = "on";
    expect(isRemoteOnlyMode()).toBe(false);
  });
});

describe("getAppConfig", () => {
  const originalEnv = process.env["RALPHER_REMOTE_ONLY"];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["RALPHER_REMOTE_ONLY"];
    } else {
      process.env["RALPHER_REMOTE_ONLY"] = originalEnv;
    }
  });

  test("returns remoteOnly: false when env var is not set", () => {
    delete process.env["RALPHER_REMOTE_ONLY"];
    const config = getAppConfig();
    expect(config).toEqual({ remoteOnly: false });
  });

  test("returns remoteOnly: true when env var is set to true", () => {
    process.env["RALPHER_REMOTE_ONLY"] = "true";
    const config = getAppConfig();
    expect(config).toEqual({ remoteOnly: true });
  });
});

describe("isMockAcpEnabled", () => {
  const originalEnv = process.env["RALPHER_MOCK_ACP"];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["RALPHER_MOCK_ACP"];
    } else {
      process.env["RALPHER_MOCK_ACP"] = originalEnv;
    }
  });

  test("returns false when env var is not set", () => {
    delete process.env["RALPHER_MOCK_ACP"];
    expect(isMockAcpEnabled()).toBe(false);
  });

  test("returns true for supported truthy values", () => {
    process.env["RALPHER_MOCK_ACP"] = "true";
    expect(isMockAcpEnabled()).toBe(true);

    process.env["RALPHER_MOCK_ACP"] = "1";
    expect(isMockAcpEnabled()).toBe(true);

    process.env["RALPHER_MOCK_ACP"] = "YES";
    expect(isMockAcpEnabled()).toBe(true);
  });

  test("returns false for unsupported values", () => {
    process.env["RALPHER_MOCK_ACP"] = "false";
    expect(isMockAcpEnabled()).toBe(false);

    process.env["RALPHER_MOCK_ACP"] = "on";
    expect(isMockAcpEnabled()).toBe(false);
  });
});
