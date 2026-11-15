import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { E2EApplication } from "./support/application";
import { OPERATION_TIMEOUT_MS, operationSignal } from "./support/timeouts";

test("a user sends notifications with Listen and a custom service's JSON payload", async () => {
  const application = await E2EApplication.create();
  const received: Array<{ contentType: string | null; body: unknown }> = [];
  const receiver = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      received.push({ contentType: request.headers.get("content-type"), body: await request.json() });
      return new Response(null, { status: 204 });
    },
  });
  const client = new Client({ name: "Notification integration", version: "1.0.0" });
  try {
    await application.start();
    await application.json("/api/preferences/notifications", {
      method: "PUT", body: JSON.stringify({ webhookUrl: `http://127.0.0.1:${receiver.port}/webhook` }),
    });
    const credential = (await application.json<{ token: string }>("/api/control/credentials", {
      method: "POST", body: JSON.stringify({
        name: "Notification integration", grant: { level: "general" }, expiresInDays: 1,
      }),
    }, 201)).data;
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", application.baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${credential.token}` } },
      fetch: (input, options) => fetch(input, { ...options, signal: operationSignal(options?.signal) }),
    }), { timeout: OPERATION_TIMEOUT_MS });
    const content = {
      title: 'Project "ready"',
      shortDescription: "The requested work is finished.",
      markdownContent: 'A line with "quotes" and \\backslashes.\nLiteral {{title}} content.',
    };
    async function send() {
      const result = await client.callTool({
        name: "clanky_send_notification", arguments: content,
      }, undefined, { timeout: OPERATION_TIMEOUT_MS });
      const entries = result.content as Array<{ type: string; text?: string }>;
      const text = entries.find((entry) => entry.type === "text")?.text;
      if (!text || result.isError) throw new Error(`Notification tool failed: ${JSON.stringify(result)}`);
      expect(JSON.parse(text)).toMatchObject({ ok: true, completion: "completed", status: "accepted" });
    }
    await send();
    expect(received.shift()).toEqual({ contentType: "application/json", body: content });

    await application.json("/api/preferences/notifications", {
      method: "PUT", body: JSON.stringify({
        payload: {
          mode: "custom",
          template: JSON.stringify({
            text: "{{title}}\n{{shortDescription}}",
            blocks: [{ text: "{{markdownContent}}" }],
          }),
        },
      }),
    });
    await send();
    expect(received.shift()).toEqual({
      contentType: "application/json",
      body: {
        text: `${content.title}\n${content.shortDescription}`,
        blocks: [{ text: content.markdownContent }],
      },
    });
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    try {
      await client.close();
    } finally {
      try {
        await application.cleanup();
      } finally {
        await receiver.stop(true);
      }
    }
  }
});
