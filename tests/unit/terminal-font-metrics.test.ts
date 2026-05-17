import { afterEach, describe, expect, test } from "bun:test";
import { installTerminalFontMetricsPatch } from "../../src/components/ssh-session/terminal-font-metrics";

const originalDocument = globalThis.document;

afterEach(() => {
  if (originalDocument) {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
    return;
  }

  Reflect.deleteProperty(globalThis, "document");
});

function mockCanvasTextMetrics(width: number, ascent = 12.1, descent = 3.2): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tagName: string) => {
        if (tagName !== "canvas") {
          throw new Error(`Unexpected test element: ${tagName}`);
        }

        return {
          getContext: () => ({
            font: "",
            measureText: () => ({
              width,
              actualBoundingBoxAscent: ascent,
              actualBoundingBoxDescent: descent,
            }),
          }),
        } as unknown as HTMLCanvasElement;
      },
    },
  });
}

function createRenderer() {
  const fills: Array<{ fillStyle: string | CanvasGradient | CanvasPattern; x: number; y: number; width: number; height: number }> = [];
  const context = {
    fillStyle: "",
    globalAlpha: 1,
    save() {},
    restore() {},
    fillRect(x: number, y: number, width: number, height: number) {
      fills.push({ fillStyle: this.fillStyle, x, y, width, height });
    },
  } as CanvasRenderingContext2D;
  const renderer = {
    ctx: context,
    fontSize: 16,
    fontFamily: "\"Ralpher Terminal Nerd Font\", monospace",
    metrics: { width: 9.6, height: 20, baseline: 16 },
    theme: { selectionBackground: "#264f78" },
    measureFont: () => ({ width: 10, height: 20, baseline: 16 }),
    renderCellBackground: (_cell: unknown, _column: number, _row: number) => {},
    renderCellText: (_cell: unknown, _column: number, _row: number) => {
      fills.push({ fillStyle: "fallback", x: -1, y: -1, width: -1, height: -1 });
    },
    rgbToCSS: (red: number, green: number, blue: number) => `rgb(${red}, ${green}, ${blue})`,
    isInSelection: () => false,
    __ralpherFontMetricsInstalled: undefined as boolean | undefined,
  };

  return { fills, renderer };
}

describe("terminal font metrics patch", () => {
  test("keeps precise canvas-measured cell width instead of rounding it up", () => {
    mockCanvasTextMetrics(9.640625);
    const { renderer } = createRenderer();

    installTerminalFontMetricsPatch({ renderer } as never);

    expect(renderer.measureFont()).toEqual({
      width: 9.640625,
      height: 18,
      baseline: 14,
    });
    expect(renderer.__ralpherFontMetricsInstalled).toBe(true);
  });

  test("snaps explicit backgrounds to integer canvas pixels", () => {
    mockCanvasTextMetrics(9.6);
    const { fills, renderer } = createRenderer();

    installTerminalFontMetricsPatch({ renderer } as never);
    renderer.renderCellBackground(
      {
        width: 1,
        bg_r: 40,
        bg_g: 40,
        bg_b: 40,
        fg_r: 238,
        fg_g: 238,
        fg_b: 238,
        flags: 0,
      } as never,
      1,
      2,
    );

    expect(fills).toEqual([
      { fillStyle: "rgb(40, 40, 40)", x: 10, y: 40, width: 9, height: 20 },
    ]);
  });

  test("renders block elements geometrically instead of delegating to canvas text", () => {
    mockCanvasTextMetrics(9.6);
    const { fills, renderer } = createRenderer();

    installTerminalFontMetricsPatch({ renderer } as never);
    renderer.renderCellText(
      {
        width: 1,
        codepoint: 0x2588,
        grapheme_len: 0,
        fg_r: 238,
        fg_g: 238,
        fg_b: 238,
        bg_r: 40,
        bg_g: 40,
        bg_b: 40,
        flags: 0,
      } as never,
      1,
      2,
    );

    expect(fills).toEqual([
      { fillStyle: "rgb(238, 238, 238)", x: 10, y: 40, width: 9, height: 20 },
    ]);
  });

  test("keeps non-block glyphs on the original text renderer", () => {
    mockCanvasTextMetrics(9.6);
    const { fills, renderer } = createRenderer();

    installTerminalFontMetricsPatch({ renderer } as never);
    renderer.renderCellText(
      {
        width: 1,
        codepoint: "A".codePointAt(0),
        grapheme_len: 0,
        flags: 0,
      } as never,
      1,
      2,
    );

    expect(fills).toEqual([
      { fillStyle: "fallback", x: -1, y: -1, width: -1, height: -1 },
    ]);
  });
});
