/**
 * Composes native services and owns deterministic connection teardown.
 */

import type { BackendConnectionConfig } from "../types";
import { createLogger } from "@pablozaiden/webapp/server";
import { HarnessError } from "../harness-errors";
import { HarnessEventHub } from "../harness-event-hub";
import { OpenCodeRuntime } from "./runtime";
import { OpenCodeModelCatalog } from "./model-catalog";
import { OpenCodeSessionService } from "./session-service";
import { OpenCodeControl } from "./control";
import { OpenCodeQuestionCoordinator } from "./question-coordinator";
import { OpenCodeControlTools } from "./control-tools";

const log = createLogger("opencode2-connection");

interface ConnectedServices {
  runtime: OpenCodeRuntime;
  client: OpenCodeRuntime["client"];
  directory: string;
  catalog: OpenCodeModelCatalog;
  sessions: OpenCodeSessionService;
  questions: OpenCodeQuestionCoordinator;
  controlTools: OpenCodeControlTools;
}

export class OpenCodeConnection {
  readonly events = new HarnessEventHub();
  private services?: ConnectedServices;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private startupAbort?: AbortController;
  private directory = "";
  private unsubscribeFailure?: () => void;

  connect(config: BackendConnectionConfig, signal?: AbortSignal): Promise<void> {
    if (this.services || this.opening) throw new HarnessError("harness_request_failed", "The native runtime is already connected or starting.");
    if (config.transport === "ssh" || config.mesh) throw new HarnessError("harness_unsupported_feature", "Native OpenCode must run on the local or a Mesh execution host.");
    this.directory = config.directory;
    this.startupAbort = new AbortController();
    const abort = (): void => this.startupAbort?.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.opening = (async () => {
      await this.closing;
      const controlTools = new OpenCodeControlTools(config.control);
      let runtime: OpenCodeRuntime;
      try {
        const env = await controlTools.open({ ...config.env, ...config.managedEnvironment }, this.startupAbort?.signal);
        runtime = await OpenCodeRuntime.open({ directory: config.directory, env }, this.startupAbort?.signal);
      } catch (error) {
        try { await controlTools.close(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "OpenCode startup and Control cleanup failed.");
        }
        throw error;
      }
      const { client, directory } = runtime;
      const catalog = new OpenCodeModelCatalog({ client, directory });
      const sessions = new OpenCodeSessionService({ client, directory, catalog, events: this.events, controlTools });
      const questions = new OpenCodeQuestionCoordinator({ client, sessions, events: this.events });
      this.unsubscribeFailure = runtime.onFailure((error) => {
        controlTools.cancelAll();
        for (const id of sessions.roots()) this.events.failSession(id, error);
        void this.disconnect().catch((cleanupError: unknown) => {
          log.error("Native connection cleanup after runtime failure failed", { error: String(cleanupError) });
        });
      });
      this.services = { runtime, client, directory, catalog, sessions, questions, controlTools };
    })().finally(() => {
      this.startupAbort = undefined;
      this.opening = undefined;
      signal?.removeEventListener("abort", abort);
    });
    return this.opening;
  }
  requireServices(): ConnectedServices {
    if (!this.services?.runtime.isOpen()) throw new HarnessError("harness_transport_closed", "Native OpenCode is disconnected.");
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
        services.controlTools.cancelAll();
        await services.sessions.finishOperations();
        try { await services.questions.close(); } catch (error) { errors.push(error); }
        const control = new OpenCodeControl(() => services);
        for (const id of services.sessions.roots()) {
          try {
            const cleanup = await control.settleOwnedWork(id);
            if (cleanup.status !== "settled") throw new HarnessError("harness_request_failed", "Native owned work did not settle.");
          } catch (error) { errors.push(error); }
        }
        this.unsubscribeFailure?.();
        this.unsubscribeFailure = undefined;
        try { await services.sessions.close(); } catch (error) { errors.push(error); }
        try { await services.runtime.close(); } catch (error) { errors.push(error); }
        try { await services.controlTools.close(); } catch (error) { errors.push(error); }
      }
      this.events.closeAll();
      if (errors.length) throw new AggregateError(errors, "Native OpenCode teardown failed.");
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }
}
