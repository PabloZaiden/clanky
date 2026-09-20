import { describe, expect, test } from "bun:test";
import { buildLocalTerminalEnvironment } from "../../src/core/terminal/local-terminal-runtime";

// This allowlist is a security boundary: interactive terminals receive the
// selected GitHub token, but not every provider or cloud credential.
describe("local terminal environment", () => {
  test("forwards GH_TOKEN without forwarding alternate auth variables", () => {
    const environment = buildLocalTerminalEnvironment(undefined, {
      GH_TOKEN: "gh-token",
      GITHUB_TOKEN: "github-token",
      COPILOT_GITHUB_TOKEN: "copilot-token",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    });

    expect(environment["GH_TOKEN"]).toBe("gh-token");
    expect(environment["GITHUB_TOKEN"]).toBeUndefined();
    expect(environment["COPILOT_GITHUB_TOKEN"]).toBeUndefined();
    expect(environment["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
  });
});
