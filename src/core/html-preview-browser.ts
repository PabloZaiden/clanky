import { spawn, type ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DomainError } from "@/domain/domain-error";
import { CONTROL_IMAGE_MAX_BYTES } from "@/shared/control-tool-result";
import { HTML_MAX_FIT_HEIGHT, htmlThemeVariables } from "@/shared/html-render";

const ReplySchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ message: z.string() }).optional(),
});

function browserExecutable(): string {
  const configured = process.env["CLANKY_HTML_BROWSER"];
  const executable = configured ? Bun.which(configured) : [
    "chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].map((candidate) => Bun.which(candidate)).find(Boolean);
  if (!executable) {
    throw new DomainError("html_browser_unavailable", "HTML preview requires Chrome or Chromium on the controller. Install it or set CLANKY_HTML_BROWSER to its executable path. Publishing does not require a browser.");
  }
  return executable;
}

class ChromePipe {
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  private failure?: Error;
  private readonly input: Duplex;
  readonly closed: Promise<void>;
  readonly console: string[] = [];

  constructor(private readonly child: ChildProcess) {
    const input = child.stdio[3];
    const output = child.stdio[4];
    if (!(input instanceof Duplex) || !(output instanceof Duplex)) throw new Error("Chrome debugging pipes are unavailable.");
    this.input = input;
    output.on("data", (chunk: Buffer) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length > 32 * 1024 * 1024) throw new Error("Chrome debugging response exceeded its byte limit.");
        let end: number;
        while ((end = this.buffer.indexOf(0)) >= 0) {
          const message = ReplySchema.parse(JSON.parse(this.buffer.subarray(0, end).toString()));
          this.buffer = this.buffer.subarray(end + 1);
          if (message.id !== undefined) {
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.error) pending?.reject(new Error(message.error.message));
            else pending?.resolve(message.result ?? {});
          } else if (this.console.length < 20) {
            if (message.method === "Runtime.consoleAPICalled") {
              const args = z.array(z.object({ value: z.unknown().optional(), description: z.string().optional() })).safeParse(message.params?.["args"]);
              if (args.success) this.console.push(args.data.map((arg) => String(arg.value ?? arg.description ?? "")).join(" ").slice(0, 1000));
            } else if (message.method === "Runtime.exceptionThrown") {
              const exception = z.object({ text: z.string(), exception: z.object({ description: z.string().optional() }).optional() }).safeParse(message.params?.["exceptionDetails"]);
              if (exception.success) this.console.push((exception.data.exception?.description ?? exception.data.text).slice(0, 1000));
            }
          }
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    input.on("error", (error) => this.fail(error));
    output.on("error", (error) => this.fail(error));
    child.on("error", (error) => this.fail(error));
    // Drain browser diagnostics without allowing stderr to block the process.
    child.stderr?.resume();
    this.closed = new Promise((resolve) => child.once("close", () => {
      this.fail(new Error("Chrome closed before completing the preview."));
      resolve();
    }));
  }

  fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  async close(): Promise<void> {
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}

export async function captureHtmlPreview(options: {
  html: string; width: number; appearance: "light" | "dark"; offset: number; signal: AbortSignal;
}) {
  const executable = browserExecutable();
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]);
  signal.throwIfAborted();
  const profile = await mkdtemp(join(tmpdir(), "clanky-html-preview-"));
  let chrome: ChromePipe | undefined;
  try {
    const child = spawn(executable, [
      "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--disable-dev-shm-usage", "--disable-extensions",
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    chrome = new ChromePipe(child);
    const onAbort = () => chrome?.fail(new DomainError("html_preview_cancelled", "HTML preview was cancelled or exceeded its time limit."));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      signal.throwIfAborted();
      const { targetId } = z.object({ targetId: z.string() }).parse(await chrome.send("Target.createTarget", { url: "about:blank" }));
      const { sessionId } = z.object({ sessionId: z.string() }).parse(await chrome.send("Target.attachToTarget", { targetId, flatten: true }));
      await chrome.send("Page.enable", {}, sessionId);
      await chrome.send("Runtime.enable", {}, sessionId);
      await chrome.send("Emulation.setDeviceMetricsOverride", {
        width: options.width, height: 1000, deviceScaleFactor: 1, mobile: false,
      }, sessionId);
      await chrome.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: options.appearance }, { name: "prefers-reduced-motion", value: "reduce" }],
      }, sessionId);
      const { frameTree } = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) }).parse(await chrome.send("Page.getFrameTree", {}, sessionId));
      const wrapper = `<!doctype html><html><head><base href="https://clanky.invalid/"><style>html,body{margin:0;padding:0;background:${options.appearance === "dark" ? "#171717" : "#ffffff"}}iframe{display:block;width:100%;border:0;height:80px}</style></head><body><iframe sandbox="allow-scripts allow-forms" title="HTML preview"></iframe><script>window.preview={height:80,loaded:false};const f=document.querySelector("iframe");addEventListener("message",e=>{if(e.source!==f.contentWindow||e.data?.type!=="clanky-html-size"||!Number.isFinite(e.data.height))return;preview.height=Math.max(80,e.data.height);f.style.height=Math.min(${HTML_MAX_FIT_HEIGHT},preview.height)+"px"});f.onload=()=>{f.contentWindow.postMessage({type:"clanky-html-theme",appearance:${JSON.stringify(options.appearance)},variables:${JSON.stringify(htmlThemeVariables(options.appearance))}},"*");preview.loaded=true};f.srcdoc=${JSON.stringify(options.html).replaceAll("<", "\\u003c")};</script></body></html>`;
      await chrome.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: wrapper }, sessionId);
      const evaluation = z.object({ result: z.object({ value: z.object({
        height: z.number(), loaded: z.boolean(),
      }) }) }).parse(await chrome.send("Runtime.evaluate", {
        expression: `new Promise(resolve=>{const started=performance.now();const tick=()=>{if(preview.loaded||performance.now()-started>5000){requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({...preview})));return}requestAnimationFrame(tick)};tick()})`,
        awaitPromise: true, returnByValue: true,
      }, sessionId));
      const contentHeight = Math.ceil(evaluation.result.value.height);
      const offset = Math.min(options.offset, Math.max(0, Math.min(contentHeight, HTML_MAX_FIT_HEIGHT) - 80));
      let capturedHeight = Math.min(2000, contentHeight - offset, HTML_MAX_FIT_HEIGHT - offset);
      let data: string;
      while (true) {
        signal.throwIfAborted();
        ({ data } = z.object({ data: z.string() }).parse(await chrome.send("Page.captureScreenshot", {
          format: "png", captureBeyondViewport: true,
          clip: { x: 0, y: offset, width: options.width, height: capturedHeight, scale: 1 },
        }, sessionId)));
        if (data.length <= CONTROL_IMAGE_MAX_BYTES) break;
        if (capturedHeight <= 100) throw new DomainError("html_preview_too_large", "The PNG exceeds the tool image limit. Preview a narrower layout or simplify the page.");
        capturedHeight = Math.max(100, Math.floor(capturedHeight / 2));
      }
      return {
        data, contentHeight, capturedHeight, offset, width: options.width,
        clipped: offset > 0 || capturedHeight < contentHeight,
        console: chrome.console,
        ...(!evaluation.result.value.loaded ? { warning: "Some external resources did not finish loading within 5 seconds." } : {}),
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("html_preview_failed", `Chrome could not capture the HTML preview: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    await chrome?.close();
    await rm(profile, { recursive: true, force: true });
  }
}
