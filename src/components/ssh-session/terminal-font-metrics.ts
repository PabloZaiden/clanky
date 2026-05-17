import type { GhosttyCell, Terminal } from "ghostty-web";

type TerminalMetrics = {
  width: number;
  height: number;
  baseline: number;
};

type RendererWithMetricHooks = {
  ctx: CanvasRenderingContext2D;
  fontSize: number;
  fontFamily: string;
  metrics: TerminalMetrics;
  theme: {
    selectionBackground: string;
  };
  measureFont?: () => TerminalMetrics;
  renderCellBackground?: (cell: GhosttyCell, column: number, row: number) => void;
  renderCellText?: (cell: GhosttyCell, column: number, row: number) => void;
  rgbToCSS?: (red: number, green: number, blue: number) => string;
  isInSelection?: (column: number, row: number) => boolean;
  __ralpherFontMetricsInstalled?: boolean;
};

const CELL_FLAG_INVERSE = 16;
const CELL_FLAG_INVISIBLE = 32;
const CELL_FLAG_FAINT = 128;

type Rect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function isBlockElement(codepoint: number): boolean {
  return codepoint >= 0x2580 && codepoint <= 0x259f;
}

function measurePreciseFont(renderer: RendererWithMetricHooks, originalMeasureFont: () => TerminalMetrics): TerminalMetrics {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) {
    return originalMeasureFont();
  }

  context.font = `${renderer.fontSize}px ${renderer.fontFamily}`;
  const measured = context.measureText("M");
  if (!Number.isFinite(measured.width) || measured.width <= 0) {
    return originalMeasureFont();
  }

  const ascent = measured.actualBoundingBoxAscent || renderer.fontSize * 0.8;
  const descent = measured.actualBoundingBoxDescent || renderer.fontSize * 0.2;
  return {
    width: measured.width,
    height: Math.ceil(ascent + descent) + 2,
    baseline: Math.ceil(ascent) + 1,
  };
}

function snappedCellRect(metrics: TerminalMetrics, column: number, row: number, cellWidth: number) {
  const left = Math.round(column * metrics.width);
  const top = Math.round(row * metrics.height);
  const right = Math.round((column + cellWidth) * metrics.width);
  const bottom = Math.round((row + 1) * metrics.height);
  return { left, top, width: right - left, height: bottom - top };
}

function snappedBlockRect(metrics: TerminalMetrics, column: number, row: number, cellWidth: number): Rect {
  const left = Math.round(column * metrics.width);
  const top = Math.round(row * metrics.height);
  return {
    left,
    top,
    right: Math.round((column + cellWidth) * metrics.width),
    bottom: Math.round((row + 1) * metrics.height),
  };
}

function verticalSlice(rect: Rect, eighthsFromLeft: number): Rect {
  return {
    ...rect,
    right: rect.left + Math.round((rect.right - rect.left) * eighthsFromLeft / 8),
  };
}

function horizontalSlice(rect: Rect, eighthsFromBottom: number): Rect {
  return {
    ...rect,
    top: rect.bottom - Math.round((rect.bottom - rect.top) * eighthsFromBottom / 8),
  };
}

function quadrantRects(codepoint: number, rect: Rect): Rect[] | null {
  const masks: Record<number, number> = {
    0x2596: 0b0100,
    0x2597: 0b1000,
    0x2598: 0b0001,
    0x2599: 0b1101,
    0x259a: 0b1001,
    0x259b: 0b0111,
    0x259c: 0b1011,
    0x259d: 0b0010,
    0x259e: 0b0110,
    0x259f: 0b1110,
  };
  const mask = masks[codepoint];
  if (mask === undefined) {
    return null;
  }

  const midX = Math.round((rect.left + rect.right) / 2);
  const midY = Math.round((rect.top + rect.bottom) / 2);
  const rects: Rect[] = [];
  if (mask & 0b0001) {
    rects.push({ left: rect.left, top: rect.top, right: midX, bottom: midY });
  }
  if (mask & 0b0010) {
    rects.push({ left: midX, top: rect.top, right: rect.right, bottom: midY });
  }
  if (mask & 0b0100) {
    rects.push({ left: rect.left, top: midY, right: midX, bottom: rect.bottom });
  }
  if (mask & 0b1000) {
    rects.push({ left: midX, top: midY, right: rect.right, bottom: rect.bottom });
  }
  return rects;
}

function blockElementRects(codepoint: number, rect: Rect): Rect[] | null {
  if (codepoint >= 0x2581 && codepoint <= 0x2587) {
    return [horizontalSlice(rect, codepoint - 0x2580)];
  }
  if (codepoint >= 0x2589 && codepoint <= 0x258f) {
    return [verticalSlice(rect, 0x2590 - codepoint)];
  }

  switch (codepoint) {
    case 0x2580:
      return [{ ...rect, bottom: Math.round((rect.top + rect.bottom) / 2) }];
    case 0x2584:
      return [horizontalSlice(rect, 4)];
    case 0x2588:
      return [rect];
    case 0x258c:
      return [verticalSlice(rect, 4)];
    case 0x2590:
      return [{ ...rect, left: rect.left + Math.round((rect.right - rect.left) / 2) }];
    case 0x2594:
      return [{ ...rect, bottom: rect.top + Math.max(1, Math.round((rect.bottom - rect.top) / 8)) }];
    case 0x2595:
      return [{ ...rect, left: rect.right - Math.max(1, Math.round((rect.right - rect.left) / 8)) }];
    default:
      return quadrantRects(codepoint, rect);
  }
}

function fillRect(ctx: CanvasRenderingContext2D, rect: Rect): void {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (width > 0 && height > 0) {
    ctx.fillRect(rect.left, rect.top, width, height);
  }
}

function foregroundCSS(renderer: RendererWithMetricHooks, cell: GhosttyCell, column: number, row: number): string {
  if (renderer.isInSelection?.(column, row)) {
    return "#ffffff";
  }
  if (cell.flags & CELL_FLAG_INVERSE) {
    return renderer.rgbToCSS?.(cell.bg_r, cell.bg_g, cell.bg_b) ?? `rgb(${cell.bg_r}, ${cell.bg_g}, ${cell.bg_b})`;
  }
  return renderer.rgbToCSS?.(cell.fg_r, cell.fg_g, cell.fg_b) ?? `rgb(${cell.fg_r}, ${cell.fg_g}, ${cell.fg_b})`;
}

function renderSnappedCellBackground(renderer: RendererWithMetricHooks, cell: GhosttyCell, column: number, row: number): void {
  const rect = snappedCellRect(renderer.metrics, column, row, cell.width);
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }

  if (renderer.isInSelection?.(column, row)) {
    renderer.ctx.fillStyle = renderer.theme.selectionBackground;
    renderer.ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
    return;
  }

  let red = cell.bg_r;
  let green = cell.bg_g;
  let blue = cell.bg_b;
  if (cell.flags & CELL_FLAG_INVERSE) {
    red = cell.fg_r;
    green = cell.fg_g;
    blue = cell.fg_b;
  }

  if (red === 0 && green === 0 && blue === 0) {
    return;
  }

  renderer.ctx.fillStyle = renderer.rgbToCSS?.(red, green, blue) ?? `rgb(${red}, ${green}, ${blue})`;
  renderer.ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
}

function renderBlockElement(renderer: RendererWithMetricHooks, cell: GhosttyCell, column: number, row: number): boolean {
  if (
    cell.width === 0
    || cell.flags & CELL_FLAG_INVISIBLE
    || cell.grapheme_len > 0
    || !isBlockElement(cell.codepoint)
  ) {
    return false;
  }

  const rects = blockElementRects(cell.codepoint, snappedBlockRect(renderer.metrics, column, row, cell.width));
  if (!rects) {
    return false;
  }

  renderer.ctx.save();
  renderer.ctx.fillStyle = foregroundCSS(renderer, cell, column, row);
  if (cell.flags & CELL_FLAG_FAINT) {
    renderer.ctx.globalAlpha = 0.5;
  }
  for (const rect of rects) {
    fillRect(renderer.ctx, rect);
  }
  renderer.ctx.restore();
  return true;
}

export function installTerminalFontMetricsPatch(terminal: Terminal): void {
  const renderer = terminal.renderer as unknown as RendererWithMetricHooks | null;
  if (
    !renderer?.measureFont
    || !renderer.renderCellBackground
    || !renderer.renderCellText
    || !renderer.ctx
    || renderer.__ralpherFontMetricsInstalled
  ) {
    return;
  }

  const originalMeasureFont = renderer.measureFont.bind(renderer);
  const originalRenderCellText = renderer.renderCellText.bind(renderer);
  renderer.measureFont = () => measurePreciseFont(renderer, originalMeasureFont);
  renderer.renderCellBackground = (cell: GhosttyCell, column: number, row: number) => {
    renderSnappedCellBackground(renderer, cell, column, row);
  };
  renderer.renderCellText = (cell: GhosttyCell, column: number, row: number) => {
    if (!renderBlockElement(renderer, cell, column, row)) {
      originalRenderCellText(cell, column, row);
    }
  };
  renderer.__ralpherFontMetricsInstalled = true;
}
