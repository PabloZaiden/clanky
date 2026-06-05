import { describe, expect, test } from "bun:test";
import {
  buildProviderAvailabilityShellCheck,
  buildProviderShellInvocation,
  getProviderAcpCommand,
} from "../../src/core/agent-runtime-command";

describe("agent runtime command", () => {
  test("quotes shell invocation arguments safely", () => {
    expect(buildProviderShellInvocation({
      command: "provider",
      args: ["arg with spaces", "it's quoted"],
    })).toBe("'provider' 'arg with spaces' 'it'\"'\"'s quoted'");
  });

  test("resolves Pi through the shared ACP package fallback", () => {
    const command = getProviderAcpCommand("pi", "ssh");

    expect(command.command).toBe("sh");
    expect(command.args).toEqual([
      "-c",
      [
        "if command -v pi-acp >/dev/null 2>&1; then",
        'exec pi-acp "$@";',
        "elif command -v npx >/dev/null 2>&1; then",
        'exec npx --yes pi-acp "$@";',
        "elif command -v bunx >/dev/null 2>&1; then",
        'exec bunx --yes pi-acp "$@";',
        "else",
        'echo "clanky: Pi ACP adapter not found. Install pi-acp or ensure npx or bunx can run pi-acp." >&2;',
        "exit 127;",
        "fi",
      ].join("\n"),
      "pi-acp",
    ]);
  });

  test("checks Pi availability using direct binary or package runners", () => {
    expect(buildProviderAvailabilityShellCheck("pi")).toBe(
      "{ command -v pi-acp >/dev/null 2>&1 || command -v npx >/dev/null 2>&1 || command -v bunx >/dev/null 2>&1; }",
    );
  });
});
