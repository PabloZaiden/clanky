/**
 * Central export for the API module.
 * 
 * Combines all API routes from individual modules into a single object
 * that can be spread into Bun's serve() routes option.
 * 
 * Route Modules:
 * - health: Server health check endpoint
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
 * - port-forwards: Browser-facing proxy routes handled separately in src/index.ts
 * 
 * @module api
 */

import { healthRoutes } from "./health";
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
import { passkeyAuthRoutes } from "./passkey-auth";
import { authRoutes } from "./auth";
import { vncSessionRoutes } from "./vnc-sessions";

/**
 * All API routes combined.
 * 
 * Spread this object into Bun's serve() routes option to register all endpoints.
 * The WebSocket endpoint and browser-facing port-forward proxy routes are handled separately in src/index.ts.
 * 
 * @example
 * ```typescript
 * Bun.serve({
 *   routes: {
 *     ...apiRoutes,
 *     // ... other routes
 *   },
 * });
 * ```
 */
export const apiRoutes = {
  ...healthRoutes,
  ...tasksRoutes,
  ...modelsAndPreferencesRoutes,
  ...settingsRoutes,
  ...gitRoutes,
  ...workspacesRoutes,
  ...agentsMdRoutes,
  ...sshServersRoutes,
  ...sshServerFilesRoutes,
  ...sshSessionsRoutes,
  ...provisioningRoutes,
  ...chatsRoutes,
  ...agentsRoutes,
  ...passkeyAuthRoutes,
  ...authRoutes,
  ...vncSessionRoutes,
};

// Re-export individual route modules
export * from "./helpers";
export * from "./health";
export * from "./tasks";
export * from "./models";
export * from "./settings";
export * from "./git";
export * from "./workspaces";
export * from "./agents-md";
export * from "./ssh-servers";
export * from "./ssh-server-files";
export * from "./port-forwards";
export * from "./ssh-sessions";
export * from "./websocket";
export * from "./provisioning";
export * from "./chats";
export * from "./agents";
export * from "./passkey-auth";
export * from "./auth";
export * from "./vnc-sessions";
export * from "./same-origin-guard";
