export class MockTerminal {
  cols = 80;
  rows = 24;
  dataHandler: ((data: string) => void) | null = null;
  resizeHandler: ((size: { cols: number; rows: number }) => void) | null = null;
  selectionChangeHandler: (() => void) | null = null;
  writes: string[] = [];
  focusCalls = 0;
  element: HTMLDivElement | null = null;
  canvas: HTMLCanvasElement | null = null;
  textarea: HTMLTextAreaElement | null = null;
  wheelHandler: ((event: WheelEvent) => boolean) | undefined;
  keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  mouseTracking = false;
  modes: Record<number, boolean> = {};
  selectionText = "";
  wasmTerm = {};
  renderer: {
    getCanvas: () => HTMLCanvasElement;
    getMetrics: () => { width: number; height: number; baseline: number };
    remeasureFont: () => void;
    resize: () => void;
    render: () => void;
  } | null = null;

  constructor(options?: Record<string, unknown>) {
    lastMockTerminal = this;
    lastMockTerminalOptions = options ?? null;
  }

  loadAddon(addon: { activate?: (terminal: MockTerminal) => void }) {
    addon.activate?.(this);
  }

  open(parent?: HTMLElement) {
    if (!(parent instanceof HTMLDivElement)) {
      return;
    }

    this.element = parent;
    parent.setAttribute("tabindex", "0");
    parent.setAttribute("contenteditable", "true");
    parent.setAttribute("role", "textbox");
    parent.setAttribute("aria-label", "Terminal input");
    parent.setAttribute("aria-multiline", "true");

    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 480,
        width: 800,
        height: 480,
        x: 0,
        y: 0,
        toJSON: () => null,
      }),
    });
    parent.appendChild(canvas);
    this.canvas = canvas;

    const textarea = document.createElement("textarea");
    textarea.setAttribute("tabindex", "0");
    textarea.setAttribute("aria-label", "Terminal input");
    textarea.style.position = "absolute";
    textarea.style.left = "0";
    textarea.style.top = "0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.opacity = "0";
    textarea.style.clipPath = "inset(50%)";
    parent.appendChild(textarea);
    this.textarea = textarea;

    canvas.addEventListener("wheel", (event) => {
      this.wheelHandler?.(event as WheelEvent);
    });
    this.renderer = {
      getCanvas: () => canvas,
      getMetrics: () => ({ width: 10, height: 20, baseline: 16 }),
      remeasureFont: () => {},
      resize: () => {},
      render: () => {},
    };
    this.focus();
  }

  focus() {
    this.focusCalls += 1;
    this.element?.focus();
  }

  write(data: string) {
    this.writes.push(data);
  }

  writeln(data: string) {
    this.writes.push(`${data}\n`);
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.resizeHandler?.({ cols, rows });
  }

  getViewportY() {
    return 0;
  }

  onData(handler: (data: string) => void) {
    this.dataHandler = handler;
    return {
      dispose: () => {
        this.dataHandler = null;
      },
    };
  }

  onResize(handler: (size: { cols: number; rows: number }) => void) {
    this.resizeHandler = handler;
    return {
      dispose: () => {
        this.resizeHandler = null;
      },
    };
  }

  onSelectionChange(handler: () => void) {
    this.selectionChangeHandler = handler;
    return {
      dispose: () => {
        this.selectionChangeHandler = null;
      },
    };
  }

  attachCustomWheelEventHandler(handler?: (event: WheelEvent) => boolean) {
    this.wheelHandler = handler;
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }

  getMode(mode: number) {
    return this.modes[mode] ?? false;
  }

  hasMouseTracking() {
    return this.mouseTracking;
  }

  getSelection() {
    return this.selectionText;
  }

  hasSelection() {
    return this.selectionText.length > 0;
  }

  clearSelection() {
    this.selectionText = "";
    this.selectionChangeHandler?.();
  }

  setSelection(text: string) {
    this.selectionText = text;
    this.selectionChangeHandler?.();
  }

  dispose() {
    this.dataHandler = null;
    this.resizeHandler = null;
    this.selectionChangeHandler = null;
    this.canvas?.remove();
    this.textarea?.remove();
    this.canvas = null;
    this.textarea = null;
    this.element = null;
    this.renderer = null;
    this.wheelHandler = undefined;
    this.keyHandler = undefined;
  }
}

export class MockFitAddon {
  terminal: MockTerminal | null = null;

  activate(terminal: MockTerminal) {
    this.terminal = terminal;
  }

  fit() {}

  observeResize() {}

  proposeDimensions() {
    if (!this.terminal) {
      return undefined;
    }
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }
}

export let lastMockTerminal: MockTerminal | null = null;
export let lastMockTerminalOptions: Record<string, unknown> | null = null;

export function resetGhosttyWebMockState(): void {
  lastMockTerminal = null;
  lastMockTerminalOptions = null;
}
