/**
 * Shared terminal output handling, including OSC 52 clipboard extraction.
 */

import { MAX_PENDING_OSC_SEQUENCE_BYTES } from "../ssh-bridge/constants";
import { extractClipboardSequences } from "../ssh-bridge/osc52";
import type { InteractiveTerminalCallbacks } from "./interactive-terminal-connection";

export class TerminalOutput {
  private readonly decoder = new TextDecoder();
  private pendingOsc = "";

  constructor(private readonly callbacks: InteractiveTerminalCallbacks) {}

  write(data: Uint8Array<ArrayBuffer>): void {
    this.writeText(this.decoder.decode(data, { stream: true }));
  }

  flush(): void {
    this.writeText(this.decoder.decode());
    if (this.pendingOsc.length > 0) {
      this.callbacks.onOutput(this.pendingOsc);
      this.pendingOsc = "";
    }
  }

  private writeText(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    const parsed = extractClipboardSequences(this.pendingOsc + chunk);
    let visibleOutput = parsed.visibleOutput;
    this.pendingOsc = parsed.remainder;
    if (Buffer.byteLength(this.pendingOsc, "utf8") > MAX_PENDING_OSC_SEQUENCE_BYTES) {
      visibleOutput += this.pendingOsc;
      this.pendingOsc = "";
    }
    if (visibleOutput.length > 0) {
      this.callbacks.onOutput(visibleOutput);
    }
    for (const clipboardText of parsed.clipboardCopies) {
      this.callbacks.onClipboardCopy?.(clipboardText);
    }
  }
}
