/**
 * Bounded no-history lifecycle notifications for transport cleanup.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "../domain/domain-error";

const log = createLogger("core:collaboration");

export class CollaborationSubscriptions<T> {
  private readonly listeners = new Set<(event: T) => void>();

  subscribe(listener: (event: T) => void): () => void {
    if (this.listeners.size >= 100) {
      throw new DomainError("collaboration_listener_limit", "Too many collaboration lifecycle subscriptions.");
    }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(event: T): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        log.error("Collaboration lifecycle subscriber failed", { error: String(error) });
      }
    }
  }
}
