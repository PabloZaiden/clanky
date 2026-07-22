import { expect, test } from "bun:test";
import { getLocalManagedCredentialBaseUrl } from "../../src/server";

test("normalizes wildcard server binds to a loopback managed credential URL", () => {
  expect(getLocalManagedCredentialBaseUrl("0.0.0.0", 3000)).toBe("http://127.0.0.1:3000");
  expect(getLocalManagedCredentialBaseUrl("127.0.0.1", 3000)).toBe("http://127.0.0.1:3000");
  expect(getLocalManagedCredentialBaseUrl("0.0.0.0", 0)).toBeUndefined();
  expect(getLocalManagedCredentialBaseUrl("192.168.1.20", 3000)).toBeUndefined();
});
