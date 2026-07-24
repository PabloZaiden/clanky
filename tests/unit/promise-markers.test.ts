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

test("recognizes PLAN_READY when the marker is wrapped in inline markdown code", () => {
  const match = detectTrailingPromiseMarker(
    "The plan is ready for review. `<promise>plan_ready</promise>`",
  );

  expect(match).toEqual({
    marker: "plan_ready",
    kind: "plan_ready",
    label: "PLAN READY",
    content: "The plan is ready for review.",
  });
});
