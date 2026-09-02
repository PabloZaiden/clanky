import { describe, expect, test } from "bun:test";

import { buildPromptParts } from "../../src/backends/prompt-parts";
import { CapabilityService } from "../../src/backends/acp/capability-service";
import { SessionService } from "../../src/backends/acp/session-service";
import { SessionStateStore } from "../../src/backends/acp/session-state";
import type { RpcRequester } from "../../src/backends/acp/contracts";
import type { JsonRpcMessage } from "../../src/backends/acp/types";
import type { MessageAttachment } from "@/shared/message-attachments";

/**
 * The resource-part shape and the successful embedded-resource path are covered at the
 * API boundary by `tests/api/chats.test.ts` ("accepts text and PDF attachments and sends
 * ACP resource parts"). Only the capability gate below is kept here: it lives inside the
 * ACP `SessionService`, underneath the `Backend` interface the chat API talks to, so no
 * public boundary can reach a provider that omits `embeddedContext`.
 */
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

describe("ACP prompt attachments", () => {
  test("rejects embedded resources before session configuration when capability is absent", async () => {
    const { requester, calls } = createRequester();
    const capability = new CapabilityService(requester);
    const state = new SessionStateStore();
    state.setCachedSession("session-1", {
      id: "session-1",
      createdAt: new Date(0).toISOString(),
      configOptions: [{
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "model-a",
        options: [
          { value: "model-a", name: "Model A" },
          { value: "model-b", name: "Model B" },
        ],
      }],
    });
    const sessions = new SessionService(
      requester,
      state,
      capability,
      () => {},
    );

    await expect(
      sessions.sendPromptAsync("session-1", {
        parts: buildPromptParts("", [textAttachment()]),
        model: {
          providerID: "copilot",
          modelID: "model-b",
        },
      }),
    ).rejects.toMatchObject({
      code: "acp_unsupported_prompt_capability",
    });
    expect(calls).toEqual([]);
    expect(state.getCachedSession("session-1")?.configOptions?.[0]?.currentValue).toBe("model-a");
  });

});
