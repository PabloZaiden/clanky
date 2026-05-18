export class MockTerminal {
  cols = 80;
  rows = 24;
  dataHandler: ((data: string) => void) | null = null;
  resizeHandler: ((size: { cols: number; rows: number }) => void) | null = null;
  selectionChangeHandler: (() => void) | null = null;
  writes: string[] = [];
  focusCalls = 0;
  element: HTMLDivElement | null = null;
  textarea: HTMLTextAreaElement | null = null;
  keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  selectionText = "";
  refreshCalls: Array<{ start: number; end: number }> = [];
  options: Record<string, unknown>;

  constructor(options?: Record<string, unknown>) {
    lastMockTerminal = this;
    lastMockTerminalOptions = options ?? null;
    this.options = { ...(options ?? {}) };
  }

  loadAddon(addon: { activate?: (terminal: MockTerminal) => void }) {
    addon.activate?.(this);
  }

  open(parent?: HTMLElement) {
    if (!(parent instanceof HTMLDivElement)) {
      return;
    }

    const element = document.createElement("div");
    element.className = "xterm";
    element.setAttribute("tabindex", "0");
    element.setAttribute("role", "textbox");
    element.setAttribute("aria-label", "Terminal input");
    element.setAttribute("aria-multiline", "true");
    parent.appendChild(element);
    this.element = element;

    const textarea = document.createElement("textarea");
    textarea.setAttribute("tabindex", "0");
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.position = "absolute";
    textarea.style.left = "0";
    textarea.style.top = "0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.opacity = "0";
    textarea.style.clipPath = "inset(50%)";
    element.appendChild(textarea);
    this.textarea = textarea;
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

  refresh(start: number, end: number) {
    this.refreshCalls.push({ start, end });
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

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
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
    this.textarea?.remove();
    this.element?.remove();
    this.textarea = null;
    this.element = null;
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
export let lastMockWebglAddon: MockWebglAddon | null = null;

export class MockWebglAddon {
  contextLossHandler: (() => void) | null = null;
  activatedTerminal: MockTerminal | null = null;
  disposeCalls = 0;

  constructor() {
    lastMockWebglAddon = this;
  }

  activate(terminal: MockTerminal) {
    this.activatedTerminal = terminal;
  }

  onContextLoss(handler: () => void) {
    this.contextLossHandler = handler;
    return {
      dispose: () => {
        this.contextLossHandler = null;
      },
    };
  }

  dispose() {
    this.disposeCalls += 1;
  }
}

export function resetXtermMockState(): void {
  lastMockTerminal = null;
  lastMockTerminalOptions = null;
  lastMockWebglAddon = null;
}
