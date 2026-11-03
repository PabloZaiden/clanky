import { expect, test } from "bun:test";
import { E2EApplication } from "./support/application";
import { pollUntil } from "./support/polling";
import {
  installExternalCodexProvider,
  installExternalNativeCopilotProvider,
  installExternalNativeOpenCodeProvider,
} from "./support/provider";

interface Chat {
  config: { id: string };
  state: {
    status: string;
    harness?: { questions?: Array<{ requestId: string; status: string; secretIdentifier?: string }> };
  };
}

interface Snapshot {
  transcript: { messages: Array<{ role: string; content: string }> };
}

const providers = [
  { adapter: "copilot", provider: "copilot", install: installExternalNativeCopilotProvider },
  { adapter: "codex", provider: "codex", install: installExternalCodexProvider },
  { adapter: "opencode2", provider: "opencode", install: installExternalNativeOpenCodeProvider },
] as const;

for (const provider of providers) {
  test(`${provider.adapter} users chat with their native provider and read their project`, async () => {
    const application = await E2EApplication.create();
    try {
      await provider.install(application.providerBinDirectory);
      await application.start();
      const host = (await application.json<Array<{ ref: Record<string, string> }>>("/api/execution-hosts"))
        .data.find((entry) => entry.ref["kind"] === "local");
      if (!host) throw new Error("Local execution host unavailable");
      const workspace = (await application.json<{ id: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: "Native project", directory: application.runDirectory, executionHost: host.ref,
          workspaceType: "directory", allowWorktrees: false, allowClankyContext: false,
          serverSettings: { agent: { adapter: provider.adapter, provider: provider.provider } },
        }),
      }, 201)).data;
      const connected = (await application.json<Array<{
        providerID: string; modelID: string; connected: boolean;
      }>>(`/api/models?workspaceId=${workspace.id}`)).data.find((entry) => entry.connected);
      if (!connected) throw new Error(`${provider.adapter} model unavailable`);
      const chat = (await application.json<Chat>("/api/chats", {
        method: "POST",
        body: JSON.stringify({
          name: "Project discussion", workspaceId: workspace.id, useWorktree: false,
          model: { providerID: connected.providerID, modelID: connected.modelID, variant: "" },
        }),
      }, 201)).data;
      const readChat = async () => (await application.json<Chat>(`/api/chats/${chat.config.id}`)).data;
      const idle = async () => {
        const state = await pollUntil(readChat,
          (value) => ["idle", "failed", "stopped"].includes(value.state.status),
          { description: `${provider.adapter} native response`, timeoutMs: 10_000, formatLastObserved: JSON.stringify });
        expect(state.state.status).toBe("idle");
        return (await application.json<Snapshot>(`/api/chats/${chat.config.id}/snapshot?full=1`)).data;
      };
      await application.json(`/api/chats/${chat.config.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          message: 'List this project.\nControl request: [{"name":"clanky_list_workspaces","input":{}}]',
        }),
      });
      expect((await idle()).transcript.messages.some((message) =>
        message.role === "assistant" && message.content.includes(workspace.id))).toBe(true);

      if (provider.adapter === "copilot") {
        const identifier = "project-cli-token";
        await application.json(`/api/chats/${chat.config.id}/messages`, {
          method: "POST", body: JSON.stringify({
            message: `Secret request: ${JSON.stringify({
              identifier, label: "CLI token", reason: "Authenticate the project CLI.",
            })}`,
          }),
        });
        const waiting = await pollUntil(readChat,
          (value) => value.state.harness?.questions?.some((question) =>
            question.status === "pending" && question.secretIdentifier === identifier) === true,
          { description: "private CLI input request", timeoutMs: 10_000, formatLastObserved: JSON.stringify });
        const question = waiting.state.harness!.questions!.find((entry) =>
          entry.status === "pending" && entry.secretIdentifier === identifier)!;
        const secret = `sanity-private-${crypto.randomUUID()}`;
        await application.json(`/api/chats/${chat.config.id}/secrets/${question.requestId}`, {
          method: "POST", body: JSON.stringify({ value: secret }),
        });
        const snapshot = await idle();
        const digest = new Bun.CryptoHasher("sha256").update(secret).digest("hex");
        expect(snapshot.transcript.messages.some((message) =>
          message.role === "assistant" && message.content.startsWith("Secret file used: ")
          && message.content.includes(digest))).toBe(true);
        expect(JSON.stringify(snapshot)).not.toContain(secret);
      }
    } catch (error) {
      console.error(await application.diagnostics());
      throw error;
    } finally {
      await application.cleanup();
    }
  });
}
