/**
 * Host capabilities shared by server and browser collaboration clients.
 */

export interface CollaborationSigningIdentity {
  nodeId: string;
  publicKey: string;
  fingerprint: string;
  sign(payload: string): Promise<string>;
}

export type CollaborationClientLogger = Pick<Console, "debug" | "info" | "warn" | "error">;
