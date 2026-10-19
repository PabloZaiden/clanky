/**
 * Approved product journey: delegate background work, receive it, and use it.
 */

import { expect } from "bun:test";
import { join } from "node:path";
import { pollUntil } from "./polling";

export interface BackgroundClient {
  json<T>(path: string, options?: { method?: string; body?: string }, expectedStatus?: number): Promise<{ data: T }>;
}

export interface BackgroundChat {
  config: { id: string };
  state: { status: string; queuedMessages?: Array<{ content: string }> };
}

interface Snapshot {
  transcript: {
    messages: Array<{ role: string; content: string }>;
    toolCalls?: Array<{
      id: string;
      status: string;
      hasOutput: boolean;
      detailAvailable: boolean;
    }>;
  };
}

interface ToolDetails {
  output?: unknown;
}

export async function prepareBackgroundChat(options: {
  client: BackgroundClient;
  directory: string;
  executionHost: Record<string, unknown>;
  adapter: string;
  provider: string;
}): Promise<string> {
  const { client, directory, executionHost, adapter, provider } = options;
  const workspace = (await client.json<{ id: string }>("/api/workspaces", {
    method: "POST", body: JSON.stringify({
      name: `${adapter} background workspace`, directory, executionHost,
      workspaceType: "directory", allowWorktrees: false,
      serverSettings: { agent: { adapter, provider } },
    }),
  }, 201)).data;
  const models = (await client.json<Array<{ providerID: string; modelID: string; connected: boolean }>>(
    `/api/models?workspaceId=${workspace.id}`,
  )).data;
  const model = models.find((entry) => entry.connected);
  if (!model) throw new Error(`No connected ${adapter} model: ${JSON.stringify(models)}`);
  return (await client.json<BackgroundChat>("/api/chats", {
    method: "POST", body: JSON.stringify({
      name: `${adapter} background conversation`, workspaceId: workspace.id,
      model: { providerID: model.providerID, modelID: model.modelID, variant: "" }, useWorktree: false,
    }),
  }, 201)).data.config.id;
}

async function observe(client: BackgroundClient, chatId: string) {
  const [chat, snapshot] = await Promise.all([
    client.json<BackgroundChat>(`/api/chats/${chatId}`),
    client.json<Snapshot>(`/api/chats/${chatId}/snapshot?full=1`),
  ]);
  if (chat.data.state.status === "failed") throw new Error(`Background conversation failed: ${JSON.stringify(chat.data)}`);
  const tools = await Promise.all((snapshot.data.transcript.toolCalls ?? [])
    .filter((tool) => tool.status === "completed" && tool.hasOutput && tool.detailAvailable)
    .map(async (tool) => (await client.json<ToolDetails>(
      `/api/chats/${chatId}/tool-calls/${encodeURIComponent(tool.id)}`,
    )).data));
  return { chat: chat.data, snapshot: snapshot.data, tools };
}

function assistantMessages(snapshot: Snapshot): string[] {
  return snapshot.transcript.messages.filter((message) => message.role === "assistant").map((message) => message.content);
}

function reportTools(tools: ToolDetails[], report: string) {
  return tools.filter((tool) => JSON.stringify(tool.output)?.includes(report));
}

export async function useBackgroundConversation(options: {
  client: BackgroundClient;
  chatId: string;
  directory: string;
  writeFile(path: string, content: string): Promise<void>;
  reconnect(): Promise<void>;
}): Promise<void> {
  const { client, chatId, directory, writeFile, reconnect } = options;
  const timeoutMs = 10_000;
  const resultPath = join(directory, "background-inventory.txt");
  const releasePath = join(directory, "inventory-review-ready.txt");
  const report = "Inventory complete: the workspace contains three reusable modules.";
  const send = async (message: string) => (await client.json<{ chat: BackgroundChat }>(
    `/api/chats/${chatId}/messages`, { method: "POST", body: JSON.stringify({ message }) },
  )).data.chat;
  await send(`Delegate the workspace inventory to a background process and review its report when ready. `
    + `[background-result:${resultPath}] [continuation-release:${releasePath}]`);
  await pollUntil(() => observe(client, chatId),
    ({ chat, snapshot }) => chat.state.status === "idle" && assistantMessages(snapshot).length > 0,
    { description: "principal to acknowledge delegation and idle while its background work runs", timeoutMs, formatLastObserved: JSON.stringify });

  await writeFile(resultPath, report);
  await pollUntil(() => observe(client, chatId),
    ({ chat, snapshot, tools }) => chat.state.status === "streaming"
      && assistantMessages(snapshot).some((content) => content.includes(report))
      && reportTools(tools, report).length > 0,
    { description: "autonomous principal to read and present the background report", timeoutMs, formatLastObserved: JSON.stringify });

  const nextStep = "Use that inventory to recommend the next module to document.";
  const queued = await send(nextStep);
  expect(queued.state.queuedMessages?.some((message) => message.content === nextStep)).toBe(true);
  await writeFile(releasePath, "The report review can finish.");
  const completed = await pollUntil(() => observe(client, chatId),
    ({ chat, snapshot }) => chat.state.status === "idle" && !chat.state.queuedMessages?.length
      && assistantMessages(snapshot).some((content) => content.includes(nextStep) && content.includes(report)),
    { description: "queued request to use the report after its autonomous review", timeoutMs, formatLastObserved: JSON.stringify });
  expect(reportTools(completed.tools, report)).toHaveLength(1);
  const persisted = assistantMessages(completed.snapshot);

  await reconnect();
  const resumedRequest = "Keep the inventory and prepare the documentation handoff.";
  await send(resumedRequest);
  const resumed = await pollUntil(() => observe(client, chatId),
    ({ chat, snapshot }) => chat.state.status === "idle"
      && assistantMessages(snapshot).some((content) => content.includes(resumedRequest) && content.includes(report)),
    { description: "resumed conversation to use its retained background report", timeoutMs, formatLastObserved: JSON.stringify });
  for (const content of persisted) {
    expect(assistantMessages(resumed.snapshot).filter((value) => value === content)).toHaveLength(1);
  }
  expect(reportTools(resumed.tools, report)).toHaveLength(1);
  await client.json(`/api/chats/${chatId}`, { method: "DELETE" });
  await client.json(`/api/trash/${chatId}`, { method: "DELETE" });
}
