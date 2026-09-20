import { describe, expect, test } from "bun:test";
import {
  getWheelDeltaLines,
  hasTerminalScrollback,
  shouldCaptureTerminalWheel,
  takeWholeScrollLines,
} from "../../src/components/terminal/terminal-scroll";

// This pure policy coverage protects the renderer boundary without adding browser automation;
// the actual xterm wheel/touch event flow is validated manually with Bun.WebView.
describe("terminal scroll policy", () => {
  test("captures wheel scrolling only for normal buffers with mouse reporting and history", () => {
    expect(hasTerminalScrollback({ type: "normal", baseY: 12 })).toBe(true);
    expect(hasTerminalScrollback({ type: "alternate", baseY: 12 })).toBe(false);
    expect(hasTerminalScrollback({ type: "normal", baseY: 0 })).toBe(false);

    expect(shouldCaptureTerminalWheel({
      buffer: { type: "normal", baseY: 12 },
      mouseTrackingMode: "vt200",
      shiftKey: false,
    })).toBe(true);
    expect(shouldCaptureTerminalWheel({
      buffer: { type: "normal", baseY: 12 },
      mouseTrackingMode: "none",
      shiftKey: false,
    })).toBe(false);
    expect(shouldCaptureTerminalWheel({
      buffer: { type: "alternate", baseY: 0 },
      mouseTrackingMode: "vt200",
      shiftKey: false,
    })).toBe(false);
    expect(shouldCaptureTerminalWheel({
      buffer: { type: "normal", baseY: 12 },
      mouseTrackingMode: "vt200",
      shiftKey: true,
    })).toBe(false);
  });

  test("normalizes wheel units and preserves fractional movement", () => {
    expect(getWheelDeltaLines({ deltaY: 24, deltaMode: 0, shiftKey: false }, 12, 24)).toBe(2);
    expect(getWheelDeltaLines({ deltaY: -3, deltaMode: 1, shiftKey: false }, 12, 24)).toBe(-3);
    expect(getWheelDeltaLines({ deltaY: 1, deltaMode: 2, shiftKey: false }, 12, 24)).toBe(24);
    expect(takeWholeScrollLines(1.75)).toEqual({ lines: 1, remainder: 0.75 });
    expect(takeWholeScrollLines(-1.75)).toEqual({ lines: -1, remainder: -0.75 });
  });
});
