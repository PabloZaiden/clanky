import { expect, test } from "bun:test";
import { CopilotEventTranslator } from "../../src/backends/copilot/event-translator";

const metadata = { id: "native-event", parentId: null, timestamp: "2026-10-03T00:00:00.000Z" };

// This SDK protocol boundary cannot be exercised by the normalized HTTP harness seam or a live provider in CI.
test("Copilot query failures permit a successful principal continuation before native idle", () => {
  const translator = new CopilotEventTranslator("owned-conversation");
  expect(translator.translate({
    ...metadata, type: "session.error", data: { errorType: "query", errorCode: "native-query-failed", message: "Synthetic query failure" },
  })).toMatchObject([{ type: "request.error", code: "harness_request_failed", details: { errorType: "query", errorCode: "native-query-failed" }, scope: { kind: "principal" } }]);
  translator.translate({
    ...metadata, type: "assistant.message", data: { messageId: "principal-response", content: "Recovered principal answer" },
  });
  expect(translator.translate({
    ...metadata, type: "session.idle", ephemeral: true, data: {},
  })).toMatchObject([{ type: "prompt.complete", outcome: "completed" }, { type: "activity.changed" }]);
});

test("Copilot child completion cannot resolve a failed principal query", () => {
  const translator = new CopilotEventTranslator("owned-conversation");
  translator.translate({
    ...metadata, type: "session.error", data: { errorType: "query", message: "Synthetic query failure" },
  });
  translator.translate({
    ...metadata, agentId: "child", type: "assistant.message", data: { messageId: "child-response", content: "Successful child answer" },
  });
  translator.translate({
    ...metadata, agentId: "child", type: "session.idle", ephemeral: true, data: {},
  });
  expect(translator.translate({
    ...metadata, type: "session.idle", ephemeral: true, data: {},
  })).toMatchObject([{ type: "error", code: "harness_request_failed", scope: { kind: "principal" } }]);
});
