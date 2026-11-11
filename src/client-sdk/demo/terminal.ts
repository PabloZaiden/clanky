import type { WebAppDuplex, WebAppDuplexHandlers } from "@pablozaiden/webapp/web";
import { MeshTerminalClientFrameSchema } from "@/contracts/schemas/mesh-terminal";
import type { TerminalSession } from "@/shared";

const PROMPT = "demo@observatory:~$ ";
const WELCOME = "Demo terminal: only ls is simulated. No shell or commands are executed.\r\n";
const LISTING = "README.md  src/\r\n";

export class DemoTerminal {
  private active?: () => void;
  private disposed = false;

  constructor(readonly session: TerminalSession, private readonly changed: () => void) {}

  async connect(options: { signal?: AbortSignal }): Promise<WebAppDuplex> {
    options.signal?.throwIfAborted();
    if (this.disposed) throw new Error("Demo terminal has ended.");
    this.active?.();
    options.signal?.throwIfAborted();
    if (this.disposed) throw new Error("Demo terminal has ended.");
    const handlers = new Set<WebAppDuplexHandlers>();
    let closed = false;
    let line = "";
    let escape: "start" | "sequence" | undefined;
    let carriageReturn = false;
    const message = (handler: WebAppDuplexHandlers, payload: object) => {
      queueMicrotask(() => { if (!closed && handlers.has(handler)) handler.onMessage(JSON.stringify(payload)); });
    };
    const publish = (payload: object) => { for (const handler of handlers) message(handler, payload); };
    const close = () => {
      if (closed) return;
      closed = true;
      line = "";
      options.signal?.removeEventListener("abort", aborted);
      if (this.active === close) {
        this.active = undefined;
        this.session.state.status = "disconnected";
        this.changed();
      }
      for (const handler of handlers) handler.onClose({ code: 1000, reason: "Demo terminal closed" });
      handlers.clear();
    };
    const aborted = () => { close(); };
    this.active = close;
    this.session.state.status = "connected";
    this.session.state.lastConnectedAt = new Date().toISOString();
    this.changed();
    options.signal?.addEventListener("abort", aborted, { once: true });

    return {
      ready: Promise.resolve(), bufferedAmount: 0,
      subscribe: handler => {
        if (closed) throw new Error("Demo terminal is closed.");
        handlers.add(handler);
        message(handler, { type: "terminal.connected", terminalSessionId: this.session.config.id });
        message(handler, { type: "terminal.output", data: WELCOME + PROMPT });
        return () => { handlers.delete(handler); };
      },
      send: async data => {
        if (closed) throw new Error("Demo terminal is closed.");
        if (typeof data !== "string") throw new Error("Demo terminal expects a JSON text frame.");
        const frame = MeshTerminalClientFrameSchema.parse(JSON.parse(data));
        if (frame.type === "terminal.close") { close(); return; }
        if (frame.type === "ping") { publish({ type: "pong" }); return; }
        if (frame.type !== "terminal.input") return;
        let output = "";
        for (const character of frame.data) {
          if (character === "\n" && carriageReturn) { carriageReturn = false; continue; }
          carriageReturn = character === "\r";
          if (escape) {
            if (escape === "start" && (character === "[" || character === "O")) escape = "sequence";
            else if (escape === "start" || /[@-~]/.test(character)) escape = undefined;
            continue;
          }
          if (character === "\x1b") { escape = "start"; continue; }
          if (character === "\r" || character === "\n") {
            const command = line.trim();
            output += "\r\n";
            if (command === "ls") output += LISTING;
            else if (command) output += `bash: ${command}: command not found\r\n`;
            output += PROMPT;
            line = "";
          } else if (character === "\x7f" || character === "\b") {
            if (line) {
              line = [...line].slice(0, -1).join("");
              output += "\b \b";
            }
          } else if (character === "\x03") {
            line = "";
            output += "^C\r\n" + PROMPT;
          } else if (!/[\x00-\x1f\x7f-\x9f]/.test(character)) {
            if (line.length >= 1024) throw new Error("Demo terminal commands cannot exceed 1024 characters.");
            line += character;
            output += character;
          }
        }
        if (output) publish({ type: "terminal.output", data: output });
      },
      close: async () => { close(); },
    };
  }

  dispose(): void {
    this.disposed = true;
    this.active?.();
  }
}
