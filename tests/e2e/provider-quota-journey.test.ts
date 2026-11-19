import { expect, test } from "bun:test";
import { E2EApplication } from "./support/application";
import { installExternalNativeClaudeProvider } from "./support/provider";
import { pollUntil } from "./support/polling";

interface Chat {
  config: { id: string };
  state: {
    status: string;
    error?: { code: string };
    harness?: { providerLimit?: {
      kind: string; retryAt?: string;
      continuation?: { status: string; nextAttemptAt?: string };
    } };
  };
}

test("users schedule a quota-blocked conversation to continue after a controller restart", async () => {
  const application = await E2EApplication.create();
  try {
    await installExternalNativeClaudeProvider(application.providerBinDirectory);
    await application.start();
    const host = (await application.json<Array<{ ref: Record<string, string> }>>("/api/execution-hosts"))
      .data.find((entry) => entry.ref["kind"] === "local")!;
    const workspace = (await application.json<{ id: string }>("/api/workspaces", {
      method: "POST", body: JSON.stringify({
        name: "Quota recovery", directory: application.runDirectory, executionHost: host.ref,
        workspaceType: "directory", allowWorktrees: false, allowClankyContext: false,
        serverSettings: { agent: { adapter: "claude", provider: "claude" } },
      }),
    }, 201)).data;
    const model = (await application.json<Array<{ providerID: string; modelID: string; connected: boolean }>>(
      `/api/models?workspaceId=${workspace.id}`)).data.find((entry) => entry.connected)!;
    const chat = (await application.json<Chat>("/api/chats", {
      method: "POST", body: JSON.stringify({
        name: "Interrupted work", workspaceId: workspace.id, useWorktree: false,
        model: { providerID: model.providerID, modelID: model.modelID, variant: "" },
      }),
    }, 201)).data;
    const url = `/api/chats/${chat.config.id}`;
    const readChat = async () => (await application.json<Chat>(url)).data;
    const resetAt = new Date(Date.now() + 2000).toISOString();
    const original = `Wait for my plan quota to reset at ${resetAt}`;
    await application.json(`${url}/messages`, { method: "POST", body: JSON.stringify({ message: original }) });
    const blocked = await pollUntil(readChat, (value) => value.state.status === "blocked", {
      description: "provider quota block", timeoutMs: 10_000, formatLastObserved: JSON.stringify,
    });
    expect(blocked.state.harness?.providerLimit?.kind).toBe("quota");
    expect(blocked.state.harness?.providerLimit?.retryAt).toBe(resetAt);
    expect(blocked.state.harness?.providerLimit?.continuation).toBeUndefined();
    await application.json(`${url}/provider-recovery`, {
      method: "POST", body: JSON.stringify({ action: "schedule" }),
    });
    await application.restart();
    const finished = await pollUntil(readChat, (value) => value.state.status === "idle" || value.state.status === "failed"
      || value.state.harness?.providerLimit?.continuation?.status === "paused", {
      description: "authorized continuation after restart", timeoutMs: 10_000, formatLastObserved: JSON.stringify,
    });
    expect(finished.state.status).toBe("idle");
    expect(finished.state.harness?.providerLimit).toBeUndefined();
    const snapshot = (await application.json<{ transcript: { messages: Array<{ role: string; content: string }> } }>(
      `${url}/snapshot?full=1`)).data;
    expect(snapshot.transcript.messages.filter((message) => message.role === "user" && message.content === original)).toHaveLength(1);
    expect(snapshot.transcript.messages.some((message) =>
      message.role === "assistant" && message.content.startsWith("Agent received: Continue the interrupted task"))).toBe(true);
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    await application.cleanup();
  }
});
