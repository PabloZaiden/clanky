import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const SINGLE_LINE_ROWS = 1 as const;
const MULTILINE_ROWS = 2 as const;
const SINGLE_LINE_MIN_HEIGHT_CLASS = "min-h-9" as const;
const MULTILINE_MIN_HEIGHT_CLASS = "min-h-[58px]" as const;
const SINGLE_LINE_PADDING_CLASS = "py-1.5" as const;
const MULTILINE_PADDING_CLASS = "py-2" as const;
const COMPOSER_WRAP_THRESHOLD_PX = 1;
const FALLBACK_LINE_HEIGHT_PX = 20;

export type ComposerRows = typeof SINGLE_LINE_ROWS | typeof MULTILINE_ROWS;
export type ComposerMinHeightClass =
  | typeof SINGLE_LINE_MIN_HEIGHT_CLASS
  | typeof MULTILINE_MIN_HEIGHT_CLASS;
export type ComposerPaddingClass =
  | typeof SINGLE_LINE_PADDING_CLASS
  | typeof MULTILINE_PADDING_CLASS;

export interface ComposerRowsMeasurement {
  contentHeight: number;
  singleLineContentHeight: number;
}

interface ComposerSizingResult {
  composerRef: (node: HTMLTextAreaElement | null) => void;
  composerRows: ComposerRows;
  composerMinHeightClass: ComposerMinHeightClass;
  composerPaddingClass: ComposerPaddingClass;
}

function hasComposerLineBreak(value: string): boolean {
  return value.includes("\n") || value.includes("\r");
}

function parsePixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getComposerLineHeight(styles: CSSStyleDeclaration): number {
  const lineHeight = parsePixelValue(styles.lineHeight);
  if (lineHeight > 0) {
    return lineHeight;
  }

  const fontSize = parsePixelValue(styles.fontSize);
  if (fontSize > 0) {
    return fontSize * 1.5;
  }

  return FALLBACK_LINE_HEIGHT_PX;
}

function getComposerRowsMeasurement(textarea: HTMLTextAreaElement): ComposerRowsMeasurement {
  const styles = window.getComputedStyle(textarea);
  const singleLineContentHeight = getComposerLineHeight(styles)
    + parsePixelValue(styles.paddingTop)
    + parsePixelValue(styles.paddingBottom);

  const previousRows = textarea.rows;
  const previousHeight = textarea.style.height;
  const previousMinHeight = textarea.style.minHeight;
  const previousOverflowY = textarea.style.overflowY;

  textarea.rows = SINGLE_LINE_ROWS;
  textarea.style.height = "0px";
  textarea.style.minHeight = "0px";
  textarea.style.overflowY = "hidden";

  const contentHeight = textarea.scrollHeight;

  textarea.rows = previousRows;
  textarea.style.height = previousHeight;
  textarea.style.minHeight = previousMinHeight;
  textarea.style.overflowY = previousOverflowY;

  return {
    contentHeight,
    singleLineContentHeight,
  };
}

export function getComposerRows(value: string, measurement?: ComposerRowsMeasurement): ComposerRows {
  if (hasComposerLineBreak(value)) {
    return MULTILINE_ROWS;
  }

  if (!measurement) {
    return SINGLE_LINE_ROWS;
  }

  return measurement.contentHeight > measurement.singleLineContentHeight + COMPOSER_WRAP_THRESHOLD_PX
    ? MULTILINE_ROWS
    : SINGLE_LINE_ROWS;
}

export function getComposerMinHeightClass(rows: ComposerRows): ComposerMinHeightClass {
  return rows === MULTILINE_ROWS ? MULTILINE_MIN_HEIGHT_CLASS : SINGLE_LINE_MIN_HEIGHT_CLASS;
}

export function getComposerPaddingClass(rows: ComposerRows): ComposerPaddingClass {
  return rows === MULTILINE_ROWS ? MULTILINE_PADDING_CLASS : SINGLE_LINE_PADDING_CLASS;
}

export function useComposerSizing(value: string): ComposerSizingResult {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const valueRef = useRef(value);
  const [composerRows, setComposerRows] = useState<ComposerRows>(() => getComposerRows(value));

  valueRef.current = value;

  const updateComposerRows = useCallback(() => {
    const textarea = textareaRef.current;
    const currentValue = valueRef.current;
    const nextRows = hasComposerLineBreak(currentValue)
      ? getComposerRows(currentValue)
      : textarea
        ? getComposerRows(currentValue, getComposerRowsMeasurement(textarea))
        : getComposerRows(currentValue);

    setComposerRows((currentRows) => currentRows === nextRows ? currentRows : nextRows);
  }, []);

  const composerRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
  }, []);

  useLayoutEffect(() => {
    updateComposerRows();
  }, [value, updateComposerRows]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      updateComposerRows();
    });
    resizeObserver.observe(textarea);

    return () => {
      resizeObserver.disconnect();
    };
  }, [updateComposerRows]);

  useEffect(() => {
    const handleWindowResize = () => {
      updateComposerRows();
    };

    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [updateComposerRows]);

  const composerMinHeightClass = useMemo(
    () => getComposerMinHeightClass(composerRows),
    [composerRows],
  );
  const composerPaddingClass = useMemo(
    () => getComposerPaddingClass(composerRows),
    [composerRows],
  );

  return {
    composerRef,
    composerRows,
    composerMinHeightClass,
    composerPaddingClass,
  };
}
