import { getAuthorizedHeaders } from "@ralpher/client-sdk";
import type {
  AcceptResponse,
  CreateChatRequest,
  CreateLoopRequest,
  InterruptChatRequest,
  ListChatsResponse,
  ListSshServersResponse,
  PlanAcceptRequest,
  SendChatMessageRequest,
  UpdateChatRequest,
  UpdateLoopRequest,
} from "@ralpher/contracts";
import type { ModelInfo, PushResponse } from "@ralpher/contracts";
import type { CreateSshServerRequest, UpdateSshServerRequest } from "@ralpher/contracts/schemas/ssh-server";
import {
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
} from "@ralpher/contracts/schemas/workspace";
import type { Chat, Loop, SshServer, Workspace } from "@ralpher/shared";
import type { z } from "zod";
import type { AuthService } from "./auth-service";

interface ApiErrorBody {
  error?: string;
  message?: string;
}

export interface DefaultBranchResponse {
  defaultBranch: string;
}

type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

export class ApiClient {
  constructor(private readonly authService: AuthService) {}

  async listServers(): Promise<ListSshServersResponse> {
    return await this.request("/api/ssh-servers");
  }

  async getServer(id: string): Promise<SshServer> {
    return await this.request(`/api/ssh-servers/${id}`);
  }

  async createServer(body: CreateSshServerRequest): Promise<SshServer> {
    return await this.request("/api/ssh-servers", {
      method: "POST",
      body,
    });
  }

  async updateServer(id: string, body: UpdateSshServerRequest): Promise<SshServer> {
    return await this.request(`/api/ssh-servers/${id}`, {
      method: "PATCH",
      body,
    });
  }

  async deleteServer(id: string): Promise<{ success: true }> {
    return await this.request(`/api/ssh-servers/${id}`, {
      method: "DELETE",
    });
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return await this.request("/api/workspaces");
  }

  async getWorkspace(id: string): Promise<Workspace> {
    return await this.request(`/api/workspaces/${id}`);
  }

  async createWorkspace(body: CreateWorkspaceRequest): Promise<Workspace> {
    return await this.request("/api/workspaces", {
      method: "POST",
      body,
    });
  }

  async updateWorkspace(id: string, body: UpdateWorkspaceRequest): Promise<Workspace> {
    return await this.request(`/api/workspaces/${id}`, {
      method: "PUT",
      body,
    });
  }

  async deleteWorkspace(id: string): Promise<{ success: true }> {
    return await this.request(`/api/workspaces/${id}`, {
      method: "DELETE",
    });
  }

  async listLoops(): Promise<Loop[]> {
    return await this.request("/api/loops");
  }

  async getLoop(id: string): Promise<Loop> {
    return await this.request(`/api/loops/${id}`);
  }

  async createLoop(body: CreateLoopRequest): Promise<Loop> {
    return await this.request("/api/loops", {
      method: "POST",
      body,
    });
  }

  async updateLoop(id: string, body: UpdateLoopRequest, draft: boolean): Promise<Loop> {
    return await this.request(`/api/loops/${id}`, {
      method: draft ? "PUT" : "PATCH",
      body,
    });
  }

  async stopLoop(id: string): Promise<{ success: true }> {
    return await this.request(`/api/loops/${id}/stop`, { method: "POST" });
  }

  async acceptLoop(id: string): Promise<AcceptResponse> {
    return await this.request(`/api/loops/${id}/accept`, { method: "POST" });
  }

  async pushLoop(id: string): Promise<PushResponse> {
    return await this.request(`/api/loops/${id}/push`, { method: "POST" });
  }

  async updateLoopBranch(id: string): Promise<PushResponse> {
    return await this.request(`/api/loops/${id}/update-branch`, { method: "POST" });
  }

  async markLoopMerged(id: string): Promise<{ success: true }> {
    return await this.request(`/api/loops/${id}/mark-merged`, { method: "POST" });
  }

  async manualCompleteLoop(id: string): Promise<{ success: true }> {
    return await this.request(`/api/loops/${id}/manual-complete`, { method: "POST" });
  }

  async discardLoop(id: string): Promise<{ success: true }> {
    return await this.request(`/api/loops/${id}/discard`, { method: "POST" });
  }

  async purgeLoop(id: string): Promise<{ success: true }> {
    return await this.request(`/api/loops/${id}/purge`, { method: "POST" });
  }

  async sendPlanFeedback(id: string, feedback: string): Promise<{ success: true }> {
    return await this.request(`/api/loops/${id}/plan/feedback`, {
      method: "POST",
      body: {
        feedback,
        attachments: [],
      },
    });
  }

  async acceptPlan(id: string, body: PlanAcceptRequest): Promise<unknown> {
    return await this.request(`/api/loops/${id}/plan/accept`, {
      method: "POST",
      body,
    });
  }

  async discardPlan(id: string): Promise<{ success: true }> {
    return await this.request(`/api/loops/${id}/plan/discard`, { method: "POST" });
  }

  async setPending(
    id: string,
    body: {
      message: string | null;
      model: CreateLoopRequest["model"] | null;
    },
  ): Promise<{ success: true }> {
    return await this.request(`/api/loops/${id}/pending`, {
      method: "POST",
      body: {
        ...body,
        immediate: true,
        attachments: [],
      },
    });
  }

  async clearPending(id: string): Promise<{ success: true }> {
    return await this.request(`/api/loops/${id}/pending`, {
      method: "DELETE",
    });
  }

  async followUpLoop(
    id: string,
    body: {
      message: string;
      model: CreateLoopRequest["model"] | null;
    },
  ): Promise<{ success: true }> {
    return await this.request(`/api/loops/${id}/follow-up`, {
      method: "POST",
      body: {
        ...body,
        attachments: [],
      },
    });
  }

  async listChats(workspaceId?: string): Promise<ListChatsResponse> {
    const search = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    return await this.request(`/api/chats${search}`);
  }

  async getChat(id: string): Promise<Chat> {
    return await this.request(`/api/chats/${id}`);
  }

  async createChat(body: CreateChatRequest): Promise<Chat> {
    return await this.request("/api/chats", {
      method: "POST",
      body,
    });
  }

  async updateChat(id: string, body: UpdateChatRequest): Promise<Chat> {
    return await this.request(`/api/chats/${id}`, {
      method: "PATCH",
      body,
    });
  }

  async deleteChat(id: string): Promise<{ success: true }> {
    return await this.request(`/api/chats/${id}`, {
      method: "DELETE",
    });
  }

  async sendChatMessage(id: string, body: SendChatMessageRequest): Promise<Chat> {
    return await this.request(`/api/chats/${id}/messages`, {
      method: "POST",
      body,
    });
  }

  async interruptChat(id: string, body: InterruptChatRequest): Promise<Chat> {
    return await this.request(`/api/chats/${id}/interrupt`, {
      method: "POST",
      body,
    });
  }

  async reconnectChat(id: string): Promise<Chat> {
    return await this.request(`/api/chats/${id}/reconnect`, {
      method: "POST",
    });
  }

  async getDefaultBranch(workspace: Workspace): Promise<string> {
    const search = new URLSearchParams({
      directory: workspace.directory,
      workspaceId: workspace.id,
    });
    const response = await this.request<DefaultBranchResponse>(`/api/git/default-branch?${search.toString()}`);
    return response.defaultBranch;
  }

  async getModels(workspace: Workspace): Promise<ModelInfo[]> {
    const search = new URLSearchParams({
      directory: workspace.directory,
      workspaceId: workspace.id,
    });
    return await this.request(`/api/models?${search.toString()}`);
  }

  private async request<T>(
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      headers?: HeadersInit;
    },
  ): Promise<T> {
    const credentials = await this.authService.getCredentials();
    const headers = getAuthorizedHeaders(credentials, init?.headers);
    headers.set("accept", "application/json");
    headers.set("origin", new URL(credentials.baseUrl).origin);

    let body: BodyInit | undefined;
    if (init?.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.body);
    }

    const response = await fetch(new URL(path, credentials.baseUrl), {
      method: init?.method ?? "GET",
      headers,
      body,
    });

    const rawBody = await response.text();
    const parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) as unknown : undefined;

    if (!response.ok) {
      const errorBody = (parsedBody ?? {}) as ApiErrorBody;
      const message = errorBody.message ?? errorBody.error ?? `Request failed with status ${String(response.status)}`;
      throw new Error(message);
    }

    return parsedBody as T;
  }
}
