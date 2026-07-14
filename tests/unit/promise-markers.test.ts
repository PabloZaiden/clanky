import { expect, test } from "bun:test";
import { detectTrailingPromiseMarker } from "../../src/utils/promise-markers";

test("recognizes and strips a trailing BLOCKED marker", () => {
  const match = detectTrailingPromiseMarker(
    "The upstream dependency is unavailable.\n<promise>BLOCKED</promise>",
  );

  expect(match).toEqual({
    marker: "BLOCKED",
    kind: "blocked",
    label: "BLOCKED",
    content: "The upstream dependency is unavailable.",
  });
});
