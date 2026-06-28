/**
 * Central export for the API module.
 * 
 * Combines all API routes from individual modules into a single object
 * that can be spread into Bun's serve() routes option.
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
 * Spread this object into Bun's serve() routes option to register all endpoints.
 * The WebSocket endpoint is handled separately in src/index.ts.
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
  ...vncSessionRoutes,
  ...previewRoutes,
};

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
