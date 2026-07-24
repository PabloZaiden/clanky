import { describe, expect, test } from "bun:test";
import { validateDeterministicAgentCode } from "../../src/core/deterministic-agent-code";

describe("deterministic agent code validation", () => {
  test("accepts a default function when declaration-like text is non-code", () => {
    const diagnostics = validateDeterministicAgentCode(`
      // export default function fake(ctx) {}
      const fake = "enum Fake {}";
      const pattern = /namespace Fake/;
      import module from "node:module";
      export default function run(ctx) {
        void fake;
        void pattern;
        void module;
      }
    `);

    expect(diagnostics).toHaveLength(0);
  });

  test("rejects Node strip-only runtime syntax", () => {
    const diagnostics = validateDeterministicAgentCode(`
      export default function run(ctx) {}
      enum Result {
        Ok,
      }
      class Example {
        constructor(private readonly value: string) {}
      }
    `);
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages.some((message) => message.includes("enum declarations"))).toBe(true);
    expect(messages.some((message) => message.includes("constructor parameter properties"))).toBe(true);
  });
});
