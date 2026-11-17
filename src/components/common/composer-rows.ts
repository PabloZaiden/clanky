import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const SINGLE_LINE_ROWS = 1 as const;
const TWO_LINE_ROWS = 2 as const;
const THREE_LINE_ROWS = 3 as const;
const SINGLE_LINE_MIN_HEIGHT_CLASS = "min-h-9" as const;
const TWO_LINE_MIN_HEIGHT_CLASS = "min-h-[58px]" as const;
const THREE_LINE_MIN_HEIGHT_CLASS = "min-h-[78px]" as const;
const SINGLE_LINE_PADDING_CLASS = "py-1.5" as const;
const MULTILINE_PADDING_CLASS = "py-2" as const;
const COMPOSER_WRAP_THRESHOLD_PX = 1;
const FALLBACK_LINE_HEIGHT_PX = 20;

export type ComposerRows = typeof SINGLE_LINE_ROWS | typeof TWO_LINE_ROWS | typeof THREE_LINE_ROWS;
export type ComposerMinHeightClass =
  | typeof SINGLE_LINE_MIN_HEIGHT_CLASS
  | typeof TWO_LINE_MIN_HEIGHT_CLASS
  | typeof THREE_LINE_MIN_HEIGHT_CLASS;
export type ComposerPaddingClass =
  | typeof SINGLE_LINE_PADDING_CLASS
  | typeof MULTILINE_PADDING_CLASS;

export interface ComposerRowsMeasurement {
  contentHeight: number;
  singleLineContentHeight: number;
  lineHeight: number;
}

interface ComposerSizingResult {
  composerRef: (node: HTMLTextAreaElement | null) => void;
  composerRows: ComposerRows;
  composerMinHeightClass: ComposerMinHeightClass;
  composerPaddingClass: ComposerPaddingClass;
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
  const lineHeight = getComposerLineHeight(styles);
  const singleLineContentHeight = lineHeight
    + parsePixelValue(styles.paddingTop)
    + parsePixelValue(styles.paddingBottom);
  const parent = textarea.parentElement;
  if (!parent) {
    throw new Error("Cannot measure an unattached composer textarea.");
  }

  // Keep per-keystroke wrap checks from changing the visible composer's layout.
  const measurementTextarea = textarea.cloneNode(false) as HTMLTextAreaElement;
  measurementTextarea.removeAttribute("id");
  measurementTextarea.removeAttribute("name");
  measurementTextarea.removeAttribute("required");
  measurementTextarea.removeAttribute("autofocus");
  measurementTextarea.disabled = true;
  measurementTextarea.setAttribute("aria-hidden", "true");
  measurementTextarea.tabIndex = -1;
  measurementTextarea.value = textarea.value;
  measurementTextarea.rows = SINGLE_LINE_ROWS;

  const textareaRect = textarea.getBoundingClientRect();
  const measurementWidth = styles.boxSizing === "border-box"
    ? textareaRect.width
    : Math.max(
      0,
      textareaRect.width
        - parsePixelValue(styles.paddingLeft)
        - parsePixelValue(styles.paddingRight)
        - parsePixelValue(styles.borderLeftWidth)
        - parsePixelValue(styles.borderRightWidth),
    );

  measurementTextarea.style.position = "fixed";
  measurementTextarea.style.top = "0px";
  measurementTextarea.style.left = "0px";
  measurementTextarea.style.width = `${measurementWidth}px`;
  measurementTextarea.style.boxSizing = styles.boxSizing;
  measurementTextarea.style.height = "0px";
  measurementTextarea.style.minHeight = "0px";
  measurementTextarea.style.overflowY = "hidden";
  measurementTextarea.style.resize = "none";
  measurementTextarea.style.visibility = "hidden";
  measurementTextarea.style.pointerEvents = "none";

  parent.append(measurementTextarea);
  let contentHeight: number;
  try {
    contentHeight = measurementTextarea.scrollHeight;
  } finally {
    measurementTextarea.remove();
  }

  return {
    contentHeight,
    singleLineContentHeight,
    lineHeight,
  };
}

export function getComposerRows(value: string, measurement?: ComposerRowsMeasurement): ComposerRows {
  const lineCount = value.split(/\r\n|\r|\n/, THREE_LINE_ROWS).length;
  if (
    lineCount >= THREE_LINE_ROWS
    || (measurement && measurement.contentHeight
      > measurement.singleLineContentHeight + measurement.lineHeight + COMPOSER_WRAP_THRESHOLD_PX)
  ) {
    return THREE_LINE_ROWS;
  }

  if (
    lineCount >= TWO_LINE_ROWS
    || (measurement && measurement.contentHeight
      > measurement.singleLineContentHeight + COMPOSER_WRAP_THRESHOLD_PX)
  ) {
    return TWO_LINE_ROWS;
  }

  return SINGLE_LINE_ROWS;
}

export function getComposerMinHeightClass(rows: ComposerRows): ComposerMinHeightClass {
  if (rows === THREE_LINE_ROWS) {
    return THREE_LINE_MIN_HEIGHT_CLASS;
  }
  return rows === TWO_LINE_ROWS ? TWO_LINE_MIN_HEIGHT_CLASS : SINGLE_LINE_MIN_HEIGHT_CLASS;
}

export function getComposerPaddingClass(rows: ComposerRows): ComposerPaddingClass {
  return rows === SINGLE_LINE_ROWS ? SINGLE_LINE_PADDING_CLASS : MULTILINE_PADDING_CLASS;
}

export function useComposerSizing(value: string): ComposerSizingResult {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const valueRef = useRef(value);
  const [composerRows, setComposerRows] = useState<ComposerRows>(() => getComposerRows(value));

  valueRef.current = value;

  const updateComposerRows = useCallback(() => {
    const textarea = textareaRef.current;
    const currentValue = valueRef.current;
    const nextRows = textarea
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
