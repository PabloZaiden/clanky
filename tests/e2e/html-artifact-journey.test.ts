import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { E2EApplication } from "./support/application";
import { pollUntil } from "./support/polling";

test("a user keeps a published visual after its source is removed and the server restarts", async () => {
  const application = await E2EApplication.create();
  try {
    await application.start();
    const host = (await application.json<Array<{ ref: Record<string, string> }>>("/api/execution-hosts"))
      .data.find((entry) => entry.ref["kind"] === "local");
    if (!host) throw new Error("Local execution host unavailable");
    const workspace = (await application.json<{ id: string }>("/api/workspaces", {
      method: "POST", body: JSON.stringify({
        name: "Visual project", directory: application.runDirectory, executionHost: host.ref,
        workspaceType: "directory", allowWorktrees: false, allowClankyContext: false,
        serverSettings: { agent: { adapter: "copilot", provider: "copilot" } },
      }),
    }, 201)).data;
    const model = (await application.json<Array<{ providerID: string; modelID: string; connected: boolean }>>(
      `/api/models?workspaceId=${workspace.id}`,
    )).data.find((entry) => entry.connected);
    if (!model) throw new Error("Native provider model unavailable");
    const chat = (await application.json<{ config: { id: string } }>("/api/chats", {
      method: "POST", body: JSON.stringify({
        name: "A visual reply", workspaceId: workspace.id, useWorktree: false,
        model: { providerID: model.providerID, modelID: model.modelID, variant: "" },
      }),
    }, 201)).data;
    const htmlPath = join(application.runDirectory, "comparison.html");
    const imagePath = join(application.runDirectory, "comparison.svg");
    await Bun.write(imagePath, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="royalblue"/></svg>');
    await Bun.write(htmlPath, '<!doctype html><html><head></head><body><h1>Project comparison</h1><img src="comparison.svg" alt="Comparison"><img src="https://images.example.com/external.png" alt="External"></body></html>');
    await application.json(`/api/chats/${chat.config.id}/messages`, {
      method: "POST", body: JSON.stringify({
        message: `Show the project comparison.\nControl request: ${JSON.stringify([{
          name: "clanky_html_render", input: { path: htmlPath, title: "Project comparison", height: 240 },
        }])}`,
      }),
    });
    const snapshotPath = `/api/chats/${chat.config.id}/snapshot?full=1`;
    type Snapshot = { transcript: { logs: Array<{ details?: { htmlRender?: { id: string; title: string } } }> } };
    const published = await pollUntil(async () => (await application.json<Snapshot>(snapshotPath)).data,
      (snapshot) => snapshot.transcript.logs.some((entry) => entry.details?.htmlRender !== undefined),
      { description: "published inline comparison", timeoutMs: 10_000, formatLastObserved: JSON.stringify });
    const reference = published.transcript.logs.find((entry) => entry.details?.htmlRender)?.details?.htmlRender;
    if (!reference) throw new Error("Published artifact reference unavailable");
    expect(reference.title).toBe("Project comparison");
    const artifactPath = `/api/chats/${chat.config.id}/html-renders/${reference.id}`;
    expect(await (await application.request(artifactPath)).text()).toContain("data:image/svg+xml;base64,");
    await rm(htmlPath);
    await rm(imagePath);
    await application.restart();
    const restored = (await application.json<Snapshot>(snapshotPath)).data;
    expect(restored.transcript.logs.some((entry) => entry.details?.htmlRender?.id === reference.id)).toBe(true);
    const response = await application.request(artifactPath);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Project comparison");
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).toContain("https://images.example.com/external.png");
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    await application.cleanup();
  }
});
