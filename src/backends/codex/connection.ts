/**
 * Composes owned native resources and provides one connection teardown path.
 */

import type { BackendConnectionConfig } from "../types";
import { HarnessError } from "../harness-errors";
import { HarnessEventHub } from "../harness-event-hub";
import { CodexRuntime } from "./runtime";
import { CodexModelCatalog } from "./model-catalog";
import { CodexSessionService } from "./session-service";
import { CodexQuestionCoordinator } from "./question-coordinator";
import { CodexControl } from "./control";

interface ConnectedServices {
  runtime: CodexRuntime;
  catalog: CodexModelCatalog;
  sessions: CodexSessionService;
  questions: CodexQuestionCoordinator;
}

export class CodexConnection {
  readonly events = new HarnessEventHub();
  private services?: ConnectedServices;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private startupAbort?: AbortController;
  private directory = "";

  connect(config: BackendConnectionConfig, signal?: AbortSignal): Promise<void> {
    if (this.services || this.opening) throw new HarnessError("harness_request_failed", "The native runtime is already connected or starting.");
    if (config.transport === "ssh" || config.mesh) throw new HarnessError("harness_unsupported_feature", "Native Codex must run on the local or a Mesh execution host.");
    this.directory = config.directory;
    this.startupAbort = new AbortController();
    const abort = (): void => this.startupAbort?.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.opening = (async () => {
      await this.closing;
      const runtime = await CodexRuntime.open({
        directory: config.directory, env: { ...config.env, ...config.managedEnvironment },
      }, this.startupAbort?.signal);
      const catalog = new CodexModelCatalog(runtime.rpc);
      const sessions = new CodexSessionService({
        runtime,
        catalog,
        events: this.events,
        managedEnvironment: config.managedEnvironment,
      });
      const questions = new CodexQuestionCoordinator({ sessions, events: this.events, runtime });
      runtime.rpc.setRequestHandler((request) => request.method === "item/tool/call"
        ? sessions.handleToolCall(request)
        : questions.handle(request));
      this.services = { runtime, catalog, sessions, questions };
    })().finally(() => {
      this.startupAbort = undefined;
      this.opening = undefined;
      signal?.removeEventListener("abort", abort);
    });
    return this.opening;
  }
  requireServices(): ConnectedServices {
    if (!this.services?.runtime.isOpen()) throw new HarnessError("harness_transport_closed", "Native Codex is disconnected.");
    return this.services;
  }
  isConnected(): boolean { return this.services?.runtime.isOpen() === true; }
  getDirectory(): string { return this.directory; }

  disconnect(): Promise<void> {
    if (this.closing) return this.closing;
    this.startupAbort?.abort();
    this.closing = (async () => {
      const errors: unknown[] = [];
      try { await this.opening; } catch (error) {
        if (!(error instanceof HarnessError && error.code === "harness_connection_aborted")) errors.push(error);
      }
      const services = this.services;
      this.services = undefined;
      if (services) {
        await services.sessions.finishOperations();
        const control = new CodexControl(() => services);
        for (const rootId of services.sessions.roots()) {
          try {
            const cleanup = await control.settleOwnedWork(rootId);
            if (cleanup.status !== "settled") throw new HarnessError("harness_request_failed", "Native work did not settle before disconnect.");
          } catch (error) { errors.push(error); }
        }
        services.questions.close();
        services.sessions.close();
        try { await services.runtime.close(); } catch (error) { errors.push(error); }
      }
      this.events.closeAll();
      if (errors.length) throw new AggregateError(errors, "Native Codex teardown failed.");
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }
}
