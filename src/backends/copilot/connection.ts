/**
 * Composes connection resources and owns the single teardown path.
 */

import type { BackendConnectionConfig } from "../types";
import { HarnessError } from "../harness-errors";
import { HarnessEventHub } from "../harness-event-hub";
import { CopilotRuntime } from "./runtime";
import { CopilotModelCatalog } from "./model-catalog";
import { CopilotQuestionCoordinator } from "./question-coordinator";
import { CopilotSessionService } from "./session-service";

interface ConnectedServices {
  runtime: CopilotRuntime;
  catalog: CopilotModelCatalog;
  questions: CopilotQuestionCoordinator;
  sessions: CopilotSessionService;
}

export class CopilotConnection {
  readonly events = new HarnessEventHub();
  private services?: ConnectedServices;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private startupAbort?: AbortController;
  private directory = "";

  connect(config: BackendConnectionConfig, signal?: AbortSignal): Promise<void> {
    if (this.opening || this.services) {
      throw new HarnessError("harness_request_failed", "This native runtime is already connected or starting.");
    }
    if (config.transport === "ssh" || config.mesh) {
      throw new HarnessError("harness_unsupported_feature", "Native Copilot must run on the selected local or Mesh execution host.");
    }
    this.directory = config.directory;
    this.startupAbort = new AbortController();
    const abort = (): void => this.startupAbort?.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.opening = (async () => {
      await this.closing;
      const runtime = await CopilotRuntime.open({
        directory: config.directory,
        env: { ...config.env, ...config.managedEnvironment },
      }, this.startupAbort?.signal);
      const catalog = new CopilotModelCatalog(runtime);
      const questions = new CopilotQuestionCoordinator(this.events);
      const sessions = new CopilotSessionService({
        runtime,
        catalog,
        events: this.events,
        questions,
        managedEnvironment: config.managedEnvironment,
      });
      this.services = { runtime, catalog, questions, sessions };
    })().finally(() => {
      signal?.removeEventListener("abort", abort);
      this.startupAbort = undefined;
      this.opening = undefined;
    });
    return this.opening;
  }

  requireServices(): ConnectedServices {
    if (!this.services?.runtime.isOpen()) throw new HarnessError("harness_transport_closed", "The native Copilot runtime is disconnected.");
    return this.services;
  }

  isConnected(): boolean {
    return this.services?.runtime.isOpen() === true;
  }

  getDirectory(): string {
    return this.directory;
  }

  disconnect(): Promise<void> {
    if (this.closing) return this.closing;
    this.startupAbort?.abort();
    this.closing = (async () => {
      const errors: unknown[] = [];
      try {
        await this.opening;
      } catch (error) {
        if (!(error instanceof HarnessError && error.code === "harness_connection_aborted")) errors.push(error);
      }
      const services = this.services;
      this.services = undefined;
      if (services) {
        try { await services.sessions.close(); } catch (error) { errors.push(error); }
        try { await services.runtime.close(); } catch (error) { errors.push(error); }
      }
      this.events.closeAll();
      if (errors.length) throw new AggregateError(errors, "Native Copilot teardown failed.");
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }
}
