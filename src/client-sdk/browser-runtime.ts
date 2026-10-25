/**
 * Clanky browser composition; integrated and detached API modes stay unchanged.
 */

import { createLogger, getWebAppClientMode } from "@pablozaiden/webapp/web";
import { DomainError } from "../domain/domain-error";
import { BrowserCollaborationClient } from "./collaboration/browser";
import { configureClientRuntime } from "./public-path";

const log = createLogger("browser-runtime");
let client: BrowserCollaborationClient | undefined;

export function isBrowserCollaborationClient(): boolean {
  return getWebAppClientMode() === "external";
}

export function getBrowserCollaborationClient(): BrowserCollaborationClient | undefined {
  if (!isBrowserCollaborationClient()) return undefined;
  if (!client) throw new DomainError("collaboration_client_unavailable", "The browser collaboration client has not started.");
  return client;
}

export async function initializeClankyClient(): Promise<void> {
  configureClientRuntime();
  if (!isBrowserCollaborationClient()) return;
  client = await BrowserCollaborationClient.open({
    catalogUrl: new URL("./webapp-assets/collaboration-operations.json", document.baseURI),
    logger: log,
  });
  configureClientRuntime({ mode: "external", external: client });
  let retired = false;
  window.addEventListener("pagehide", () => {
    retired = true;
    // Page exit cannot await JavaScript; the client still owns and reports stop.
    void client!.stop().catch((error: unknown) => log.error("Browser transport shutdown failed", { error: String(error) }));
  }, { once: true });
  window.addEventListener("pageshow", (event: PageTransitionEvent) => {
    if (event.persisted) window.location.reload();
  });
  document.addEventListener("visibilitychange", () => {
    if (!retired && document.visibilityState === "visible") client!.resynchronize();
  });
}
