/**
 * Selectively enforces mesh authority for API mutations.
 *
 * Local-only preferences and stdio resources remain usable on a passive node.
 * SSH-backed resources and authority-management operations require the current
 * takeover claim before their route handler is allowed to mutate state.
 */

import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { agentManager } from "./agent-manager";
import { chatManager } from "./chat-manager";
import { taskManager } from "./task-manager";
import { workspaceManager } from "./workspace-manager";
import { assertLocalMeshActive, assertLocalMeshActiveForAggregate } from "./mesh-activity";
import { isMeshAggregateEligible } from "../persistence/mesh-sync";

const SSH_ONLY_PREFIXES = [
  "/api/ssh-servers",
  "/api/ssh-sessions",
  "/api/ssh-server-sessions",
  "/api/provisioning",
  "/api/provisioning-jobs",
  "/api/vnc-sessions",
  "/api/previews",
  "/api/file-explorer",
];

const LOCAL_ONLY_PREFIXES = [
  "/api/models",
  "/api/settings",
];

function pathParts(pathname: string): string[] {
  return pathname.split("/").filter((part) => part.length > 0);
}

async function parseBody(req: Request): Promise<Record<string, unknown> | null> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return null;
  }
  try {
    const body: unknown = await req.clone().json();
    return typeof body === "object" && body !== null
      ? body as Record<string, unknown>
      : null;
  } catch {
    // The route's own validator will report malformed JSON. A null body is
    // handled conservatively below so it cannot bypass the authority check.
    return null;
  }
}

function isSshWorkspaceBody(body: Record<string, unknown> | null): boolean | null {
  const settings = body?.["serverSettings"];
  if (typeof settings !== "object" || settings === null) {
    return null;
  }
  const agent = (settings as Record<string, unknown>)["agent"];
  if (typeof agent !== "object" || agent === null) {
    return null;
  }
  const transport = (agent as Record<string, unknown>)["transport"];
  return transport === "ssh" ? true : transport === "stdio" ? false : null;
}

async function guardTaskMutation(userId: string, parts: string[], req: Request): Promise<void> {
  const taskId = parts[0];
  if (taskId) {
    const task = await taskManager.getTask(taskId);
    if (!task) {
      await assertLocalMeshActive(userId);
      return;
    }
    await assertLocalMeshActiveForAggregate(userId, "task", task.config.id);
    return;
  }
  const body = await parseBody(req);
  const workspaceId = typeof body?.["workspaceId"] === "string" ? body["workspaceId"] : null;
  if (!workspaceId || isMeshAggregateEligible(userId, "workspace", workspaceId)) {
    await assertLocalMeshActive(userId);
    return;
  }
  await assertLocalMeshActiveForAggregate(userId, "workspace", workspaceId);
}

async function guardChatMutation(userId: string, parts: string[], req: Request): Promise<void> {
  const chatId = parts[0];
  if (chatId) {
    const chat = await chatManager.getChat(chatId);
    if (!chat) {
      await assertLocalMeshActive(userId);
      return;
    }
    await assertLocalMeshActiveForAggregate(userId, "chat", chat.config.id);
    return;
  }
  const body = await parseBody(req);
  const workspaceId = typeof body?.["workspaceId"] === "string" ? body["workspaceId"] : null;
  const sshServerId = typeof body?.["sshServerId"] === "string" ? body["sshServerId"] : null;
  if (sshServerId || !workspaceId) {
    await assertLocalMeshActive(userId);
    return;
  }
  await assertLocalMeshActiveForAggregate(userId, "workspace", workspaceId);
}

async function guardAgentMutation(userId: string, parts: string[], req: Request): Promise<void> {
  const agentId = parts[0];
  if (agentId) {
    const agent = await agentManager.getAgent(agentId);
    if (!agent) {
      await assertLocalMeshActive(userId);
      return;
    }
    await assertLocalMeshActiveForAggregate(userId, "agent", agent.config.id);
    return;
  }
  const body = await parseBody(req);
  const workspaceId = typeof body?.["workspaceId"] === "string" ? body["workspaceId"] : null;
  if (!workspaceId) {
    await assertLocalMeshActive(userId);
    return;
  }
  await assertLocalMeshActiveForAggregate(userId, "workspace", workspaceId);
}

async function guardAgentRunMutation(userId: string, parts: string[]): Promise<void> {
  const runId = parts[0];
  if (!runId) {
    await assertLocalMeshActive(userId);
    return;
  }
  const run = await agentManager.getRun(runId);
  if (!run) {
    await assertLocalMeshActive(userId);
    return;
  }
  await assertLocalMeshActiveForAggregate(userId, "agent_run", run.id);
}

async function guardAgentPromptMutation(userId: string, req: Request): Promise<void> {
  const body = await parseBody(req);
  const chatId = typeof body?.["chatId"] === "string" ? body["chatId"] : null;
  if (!chatId) {
    await assertLocalMeshActive(userId);
    return;
  }
  await guardChatMutation(userId, [chatId], req);
}

async function guardWorkspaceMutation(userId: string, parts: string[], req: Request): Promise<void> {
  const workspaceId = parts[0];
  if (workspaceId) {
    const workspace = await workspaceManager.getWorkspace(workspaceId);
    if (!workspace) {
      await assertLocalMeshActive(userId);
      return;
    }
    if (isMeshAggregateEligible(userId, "workspace", workspace.id)) {
      await assertLocalMeshActive(userId);
      return;
    }
    const body = await parseBody(req);
    if (isSshWorkspaceBody(body) === true) {
      await assertLocalMeshActive(userId);
    }
    return;
  }
  const body = await parseBody(req);
  if (isSshWorkspaceBody(body) !== false) {
    await assertLocalMeshActive(userId);
  }
}

export async function assertMeshApiMutationAllowed(
  user: CurrentUser,
  req: Request,
): Promise<void> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return;
  }
  const pathname = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  if (
    pathname === "/api/mesh/takeover"
    || pathname === "/api/mesh/rejoin"
    || /^\/api\/mesh\/pairing-requests\/[^/]+\/complete$/.test(pathname)
  ) {
    return;
  }
  if (pathname === "/api/internal/agent-prompt") {
    await guardAgentPromptMutation(user.id, req);
    return;
  }
  if (LOCAL_ONLY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return;
  }
  if (pathname === "/api/mesh" || pathname.startsWith("/api/mesh/")) {
    await assertLocalMeshActive(user.id);
    return;
  }
  if (SSH_ONLY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    await assertLocalMeshActive(user.id);
    return;
  }

  const parts = pathParts(pathname);
  if (parts[0] === "api" && parts[1] === "tasks") {
    await guardTaskMutation(user.id, parts.slice(2), req);
    return;
  }
  if (parts[0] === "api" && parts[1] === "chats") {
    await guardChatMutation(user.id, parts.slice(2), req);
    return;
  }
  if (parts[0] === "api" && parts[1] === "agents") {
    await guardAgentMutation(user.id, parts.slice(2), req);
    return;
  }
  if (parts[0] === "api" && parts[1] === "agent-runs") {
    await guardAgentRunMutation(user.id, parts.slice(2));
    return;
  }
  if (parts[0] === "api" && parts[1] === "workspaces") {
    await guardWorkspaceMutation(user.id, parts.slice(2), req);
  }
}
