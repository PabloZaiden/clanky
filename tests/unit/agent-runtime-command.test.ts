import { describe, expect, test } from "bun:test";
import { buildProviderShellInvocation } from "../../src/core/agent-runtime-command";

describe("agent runtime command", () => {
  test("quotes shell invocation arguments safely", () => {
    expect(buildProviderShellInvocation({
      command: "provider",
      args: ["arg with spaces", "it's quoted"],
    })).toBe("'provider' 'arg with spaces' 'it'\"'\"'s quoted'");
  });
});
