import { describe, expect, test } from "bun:test";
import { MockAcpBackend, NeverCompletingMockBackend } from "../mocks/mock-backend";

describe("mock backend session ids", () => {
  test("MockAcpBackend creates unique session ids even within the same millisecond", async () => {
    const backend = new MockAcpBackend();
    const originalNow = Date.now;
    Date.now = () => 1234567890;

    try {
      const first = await backend.createSession({ title: "first", directory: "/tmp" });
      const second = await backend.createSession({ title: "second", directory: "/tmp" });

      expect(first.id).not.toBe(second.id);
      expect(first.id.startsWith("mock-session-")).toBe(true);
      expect(second.id.startsWith("mock-session-")).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });

  test("NeverCompletingMockBackend creates unique session ids even within the same millisecond", async () => {
    const backend = new NeverCompletingMockBackend();
    const originalNow = Date.now;
    Date.now = () => 1234567890;

    try {
      const first = await backend.createSession({ title: "first", directory: "/tmp" });
      const second = await backend.createSession({ title: "second", directory: "/tmp" });

      expect(first.id).not.toBe(second.id);
      expect(first.id.startsWith("mock-session-")).toBe(true);
      expect(second.id.startsWith("mock-session-")).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });
});
