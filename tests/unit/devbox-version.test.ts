import { describe, expect, test } from "bun:test";
import { parseDevboxVersion } from "../../src/core/devbox-version";

describe("Devbox version parsing", () => {
  test("accepts only complete release versions", () => {
    expect(parseDevboxVersion("devbox v1.2.0\nUsage: devbox")).toBe("1.2.0");
    expect(parseDevboxVersion("devbox v1.2.0-rc.1\n")).toBeNull();
    expect(parseDevboxVersion("devbox v1.2.0.1\n")).toBeNull();
  });
});
