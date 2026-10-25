/**
 * Exclusive browser ownership without stealing another tab's relay identity.
 */

import { DomainError } from "../../domain/domain-error";
import type { CollaborationConnectionLease, CollaborationConnectionOwnership } from "./store";

export class BrowserCollaborationOwnership implements CollaborationConnectionOwnership {
  constructor(private readonly scope: string) {}

  async acquire(kind: "destination" | "connection", key: string): Promise<CollaborationConnectionLease> {
    return await new Promise<CollaborationConnectionLease>((resolve, reject) => {
      const name = JSON.stringify(["clanky-collaboration", this.scope, kind, key]);
      const request = navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (!lock) {
          reject(new DomainError("collaboration_connection_in_use", "This connection is in use in another Clanky tab."));
          return;
        }
        let release!: () => void;
        const held = new Promise<void>((finish) => { release = finish; });
        resolve({
          async release(): Promise<void> {
            release();
            await request;
          },
        });
        await held;
      });
      void request.catch((error: unknown) => reject(new DomainError(
        "collaboration_browser_unsupported", "The browser could not acquire exclusive pairing ownership.", { cause: error },
      )));
    });
  }
}
