import { describe, expect, test } from "bun:test";
import { detectTrailingPromiseMarker } from "../../src/utils/promise-markers";

describe("detectTrailingPromiseMarker", () => {
  test("uses uppercase labels for PLAN_READY markers", () => {
    expect(detectTrailingPromiseMarker("Plan created\n<promise>PLAN_READY</promise>")).toEqual({
      marker: "PLAN_READY",
      kind: "plan_ready",
      label: "PLAN READY",
      content: "Plan created",
    });
  });

  test("uses uppercase labels for COMPLETE markers", () => {
    expect(detectTrailingPromiseMarker("<promise>COMPLETE</promise>")).toEqual({
      marker: "COMPLETE",
      kind: "complete",
      label: "COMPLETED",
      content: "",
    });
  });
});
