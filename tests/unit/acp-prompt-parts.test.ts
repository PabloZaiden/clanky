import { describe, expect, test } from "bun:test";

import { buildPromptParts } from "../../src/backends/prompt-parts";
import { CapabilityService } from "../../src/backends/acp/capability-service";
import { SessionService } from "../../src/backends/acp/session-service";
import { SessionStateStore } from "../../src/backends/acp/session-state";
import type { RpcRequester } from "../../src/backends/acp/contracts";
import type { JsonRpcMessage } from "../../src/backends/acp/types";
import type { MessageAttachment } from "@/shared/message-attachments";

function createRequester(): {
  requester: RpcRequester;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const requester: RpcRequester = {
    async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      return {} as T;
    },
    writeMessage(_message: JsonRpcMessage): void {},
  };
  return { requester, calls };
}

function textAttachment(): MessageAttachment {
  const data = Buffer.from("# Read me\n\nThis is embedded text.", "utf8").toString("base64");
  return {
    id: "text-1",
    filename: "readme.md",
    mimeType: "text/markdown",
    data,
    size: Buffer.byteLength("# Read me\n\nThis is embedded text.", "utf8"),
  };
}

function pdfAttachment(): MessageAttachment {
  const data = Buffer.from("%PDF-test", "utf8").toString("base64");
  return {
    id: "pdf-1",
    filename: "report.pdf",
    mimeType: "application/pdf",
    data,
    size: Buffer.byteLength("%PDF-test", "utf8"),
  };
}

describe("ACP prompt attachments", () => {
  test("maps text and PDF attachments to embedded ACP resources", () => {
    const parts = buildPromptParts("Inspect these files", [textAttachment(), pdfAttachment()]);

    expect(parts).toEqual([
      { type: "text", text: "Inspect these files" },
      {
        type: "resource",
        resource: {
          uri: "attachment://text-1/readme.md",
          mimeType: "text/markdown",
          text: "# Read me\n\nThis is embedded text.",
        },
      },
      {
        type: "resource",
        resource: {
          uri: "attachment://pdf-1/report.pdf",
          mimeType: "application/pdf",
          blob: Buffer.from("%PDF-test", "utf8").toString("base64"),
        },
      },
    ]);
  });

  test("rejects embedded resources before session/prompt when capability is absent", async () => {
    const { requester, calls } = createRequester();
    const capability = new CapabilityService(requester);
    const sessions = new SessionService(
      requester,
      new SessionStateStore(),
      capability,
      () => {},
    );

    await expect(
      sessions.sendPromptAsync("session-1", { parts: buildPromptParts("", [textAttachment()]) }),
    ).rejects.toMatchObject({
      code: "acp_unsupported_prompt_capability",
    });
    expect(calls).toEqual([]);
  });

  test("serializes embedded resources after initialize advertises embeddedContext", async () => {
    const { requester, calls } = createRequester();
    const capability = new CapabilityService(requester);
    capability.setInitializeResult({
      agentCapabilities: {
        promptCapabilities: {
          embeddedContext: true,
        },
      },
    });
    const sessions = new SessionService(
      requester,
      new SessionStateStore(),
      capability,
      () => {},
    );

    await sessions.sendPromptAsync("session-1", { parts: buildPromptParts("", [pdfAttachment()]) });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "session/prompt",
      params: {
        sessionId: "session-1",
        prompt: [
          {
            type: "resource",
            resource: {
              uri: "attachment://pdf-1/report.pdf",
              mimeType: "application/pdf",
              blob: Buffer.from("%PDF-test", "utf8").toString("base64"),
            },
          },
        ],
      },
    });
  });
});
