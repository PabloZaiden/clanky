/**
 * Central export for the API module.
 * 
 * Combines all API routes from individual modules into the webapp server's
 * native route table.
 * 
 * Route Modules:
 * - tasks: Task CRUD, control, data, and review operations
 * - models: AI model listing and user preferences
 * - settings: Server configuration and connection management
 * - git: Git repository information
 * - workspaces: Workspace CRUD operations
 * - agents-md: AGENTS.md optimization for Clanky
 * - ssh-servers: Standalone SSH server registry, credentials, and ad-hoc sessions
 * - ssh-sessions: Workspace-backed persistent SSH sessions
 * - provisioning: Remote workspace provisioning jobs
 * - websocket: Real-time event streaming (handled separately)
 * 
 * @module api
 */

import { defineRoutes, type RouteDefinition, type RouteTable } from "@pablozaiden/webapp/server";
import { runWithCurrentUser } from "../core/user-context";
import { tasksRoutes } from "./tasks";
import { modelsAndPreferencesRoutes } from "./models";
import { settingsRoutes } from "./settings";
import { gitRoutes } from "./git";
import { workspacesRoutes } from "./workspaces";
import { agentsMdRoutes } from "./agents-md";
import { sshServersRoutes } from "./ssh-servers";
import { sshServerFilesRoutes } from "./ssh-server-files";
import { sshSessionsRoutes } from "./ssh-sessions";
import { provisioningRoutes } from "./provisioning";
import { chatsRoutes } from "./chats";
import { agentsRoutes } from "./agents";
import { vncSessionRoutes } from "./vnc-sessions";
import { previewRoutes } from "./previews";

/**
 * All API routes combined.
 * 
 * The WebSocket endpoint is handled separately in src/index.ts.
 */
const nativeApiRoutes = {
  ...tasksRoutes,
  ...modelsAndPreferencesRoutes,
  ...settingsRoutes,
  ...gitRoutes,
  ...workspacesRoutes,
  ...agentsMdRoutes,
  ...sshServerFilesRoutes,
  ...sshServersRoutes,
  ...sshSessionsRoutes,
  ...provisioningRoutes,
  ...chatsRoutes,
  ...agentsRoutes,
  ...vncSessionRoutes,
  ...previewRoutes,
};

const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Establish Clanky's compatibility user context around native webapp route
 * handlers. Authorization and same-origin policy remain on each route.
 */
function withApiUserContext(routes: Record<string, RouteDefinition>): RouteTable {
  return Object.fromEntries(Object.entries(routes).map(([path, route]) => {
    const routeWithContext: RouteDefinition = { ...route };
    for (const method of API_METHODS) {
      const handler = route[method];
      if (!handler) continue;
      routeWithContext[method] = async (req, ctx) => {
        const user = ctx.requireUser();
        return await runWithCurrentUser(user, () => handler(req, ctx));
      };
    }
    return [path, routeWithContext];
  }));
}

export const apiRoutes = defineRoutes(withApiUserContext(nativeApiRoutes));

// Re-export individual route modules
export * from "./helpers";
export * from "./tasks";
export * from "./models";
export * from "./settings";
export * from "./git";
export * from "./workspaces";
export * from "./agents-md";
export * from "./ssh-servers";
export * from "./ssh-server-files";
export * from "./ssh-sessions";
export * from "./websocket";
export * from "./provisioning";
export * from "./chats";
export * from "./agents";
export * from "./vnc-sessions";
export * from "./previews";
