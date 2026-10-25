/**
 * User-context adapters for the shared invited terminal and preview bridge.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { runWithCurrentUser } from "../context/user-context";
import { workspaceConnections } from "../core/workspace-connections";
import {
  CollaborationSocketBridge, collaborationTerminalOperation, collaborationPreviewOperation,
} from "../client-sdk/collaboration/socket";

const log = createLogger("api:workspace-socket-proxy");

export function remoteTerminalProxy(id: string, user: CurrentUser): CollaborationSocketBridge | undefined {
  const target = collaborationTerminalOperation(id);
  if (!target) return undefined;
  const runtime = runWithCurrentUser(user, () => workspaceConnections.require(target.connectionId));
  return new CollaborationSocketBridge(runtime, target.operation, log);
}

export function remotePreviewProxy(raw: string | Buffer, user: CurrentUser): {
  proxy: CollaborationSocketBridge;
  hello: string;
} | undefined {
  const target = collaborationPreviewOperation(typeof raw === "string" ? raw : raw.toString());
  if (!target) return undefined;
  const runtime = runWithCurrentUser(user, () => workspaceConnections.require(target.connectionId));
  return { proxy: new CollaborationSocketBridge(runtime, target.operation, log), hello: target.hello };
}
