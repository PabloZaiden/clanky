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
  config: { id: string; workspaceId?: string; source?: { workspaceId?: string }; model?: unknown };
  state: {
    status: string; error?: unknown; queuedMessages?: Array<{ content: string }>;
    usage?: { outputTokens?: number; inputTokens?: number };
  };
}

interface Snapshot {
  transcript: {
    messages: Array<{ id: string; role: string; content: string; attachments?: Array<{ mimeType: string; data: string }> }>;
    logs?: Array<{ details?: { logKind?: string; responseContent?: string } }>;
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

interface SavedSubagent {
  id: string;
  activity: { id: string; parentId?: string; description: string };
  coverage: string;
  observation: string;
}

interface ChildSnapshot extends Snapshot { subagent: SavedSubagent }

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
  onChildObserved?: (id: string) => Promise<void>;
  verifyIsolation?: boolean;
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
  const childrenPath = `/api/chats/${chatId}/subagents`;
  const children = await pollUntil(async () => (await client.json<{ items: SavedSubagent[] }>(childrenPath)).data.items,
    (items) => items.some((item) => item.activity.description === "Workspace inventory"),
    { description: "delegated child to be retained without a browser subscription", timeoutMs, formatLastObserved: JSON.stringify });
  const child = children.find((item) => item.activity.description === "Workspace inventory")!;
  const childPath = `${childrenPath}/${encodeURIComponent(child.id)}`;
  const partial = await pollUntil(async () => (await client.json<ChildSnapshot>(`${childPath}/snapshot?full=1`)).data,
    (snapshot) => snapshot.transcript.messages.some((message) => message.content === "Inspect the reusable modules and report the inventory.")
      && snapshot.transcript.messages.some((message) => message.content === "Inspecting reusable modules..."),
    { description: "child instruction and partial response to be readable live", timeoutMs, formatLastObserved: JSON.stringify });
  expect(partial.subagent.coverage).toBe("partial");
  await options.onChildObserved?.(child.id);
  if (options.verifyIsolation) {
    const parent = (await client.json<BackgroundChat>(`/api/chats/${chatId}`)).data;
    const unrelated = (await client.json<BackgroundChat>("/api/chats", {
      method: "POST", body: JSON.stringify({ name: "Unrelated conversation",
        workspaceId: parent.config.source?.workspaceId ?? parent.config.workspaceId, model: parent.config.model, useWorktree: false }),
    }, 201)).data;
    await client.json(`/api/chats/${unrelated.config.id}/subagents/${child.id}/snapshot`, undefined, 404);
    await client.json(`/api/chats/${unrelated.config.id}`, { method: "DELETE" });
    await client.json(`/api/trash/${unrelated.config.id}`, { method: "DELETE" });
    const nested = children.find((item) => item.activity.parentId === child.activity.id);
    expect(nested).toBeDefined();
    const nestedSnapshot = (await client.json<ChildSnapshot>(`${childrenPath}/${nested!.id}/snapshot`)).data;
    expect(assistantMessages(nestedSnapshot)).toEqual(["Nested review complete."]);
  }

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
      && (chat.state.usage?.outputTokens ?? 0) > 0
      && assistantMessages(snapshot).some((content) => content.includes(nextStep) && content.includes(report)),
    { description: "queued request to use the report after its autonomous review", timeoutMs, formatLastObserved: JSON.stringify });
  expect(reportTools(completed.tools, report)).toHaveLength(1);
  const outputTokens = completed.chat.state.usage!.outputTokens!;
  expect(completed.chat.state.usage!.inputTokens).toBeGreaterThan(0);
  const persisted = assistantMessages(completed.snapshot);
  expect(persisted.some((content) => content.startsWith("Subagent findings:") || content === "Nested review complete.")).toBe(false);
  const finishedChild = await pollUntil(async () => (await client.json<ChildSnapshot>(`${childPath}/snapshot?full=1`)).data,
    (snapshot) => snapshot.subagent.coverage === "complete"
      && assistantMessages(snapshot).includes(`Subagent findings: ${report}`),
    { description: "completed child history and tools to be retained independently", timeoutMs, formatLastObserved: JSON.stringify });
  expect(finishedChild.transcript.messages.filter((message) => message.role === "assistant" && message.content)).toHaveLength(1);
  expect(finishedChild.transcript.messages.flatMap((message) => message.attachments ?? [])
    .filter((attachment) => attachment.mimeType === "image/png" && attachment.data.length > 0)).toHaveLength(1);
  expect(finishedChild.transcript.logs?.filter((entry) => entry.details?.logKind === "reasoning")
    .map((entry) => entry.details?.responseContent)).toEqual(["Checking the reusable modules. The inventory is ready."]);
  const childTools = finishedChild.transcript.toolCalls ?? [];
  expect(childTools).toHaveLength(1);
  const childTool = (await client.json<ToolDetails>(`${childPath}/tool-calls/${encodeURIComponent(childTools[0]!.id)}`)).data;
  expect(JSON.stringify(childTool.output)).toContain(report);

  await reconnect();
  const reopened = await observe(client, chatId);
  expect(reopened.chat.state.status).toBe("idle");
  expect(reopened.chat.state.error).toBeUndefined();
  expect(reopened.chat.state.usage?.outputTokens).toBeGreaterThanOrEqual(outputTokens);
  const reopenedOutputTokens = reopened.chat.state.usage!.outputTokens!;
  const resumedRequest = "Keep the inventory and prepare the documentation handoff.";
  await send(resumedRequest);
  const resumed = await pollUntil(() => observe(client, chatId),
    ({ chat, snapshot }) => chat.state.status === "idle"
      && (chat.state.usage?.outputTokens ?? 0) > reopenedOutputTokens
      && assistantMessages(snapshot).some((content) => content.includes(resumedRequest) && content.includes(report)),
    { description: "resumed conversation to use its retained background report", timeoutMs, formatLastObserved: JSON.stringify });
  for (const content of persisted) {
    expect(assistantMessages(resumed.snapshot).filter((value) => value === content)).toHaveLength(1);
  }
  expect(reportTools(resumed.tools, report)).toHaveLength(1);
  const recoveredChild = (await client.json<ChildSnapshot>(`${childPath}/snapshot?full=1`)).data;
  expect(recoveredChild.transcript.messages).toEqual(finishedChild.transcript.messages);
  expect(recoveredChild.transcript.toolCalls?.map((tool) => tool.id)).toEqual(childTools.map((tool) => tool.id));
  await reconnect();
  const offlineChild = (await client.json<ChildSnapshot>(`${childPath}/snapshot?full=1`)).data;
  expect(offlineChild.transcript.messages).toEqual(finishedChild.transcript.messages);
  expect((await client.json<{ items: SavedSubagent[] }>(childrenPath)).data.items.map((item) => item.id)).toContain(child.id);
  await client.json(`/api/chats/${chatId}`, { method: "DELETE" });
  await client.json(`${childPath}/snapshot`, undefined, 404);
  await client.json(`/api/trash/${chatId}/restore`, { method: "POST" });
  expect((await client.json<ChildSnapshot>(`${childPath}/snapshot?full=1`)).data.transcript.messages).toEqual(finishedChild.transcript.messages);
  await client.json(`/api/chats/${chatId}`, { method: "DELETE" });
  await client.json(`/api/trash/${chatId}`, { method: "DELETE" });
  await client.json(`${childPath}/snapshot`, undefined, 404);
}
