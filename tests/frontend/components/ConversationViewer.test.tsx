import { describe, expect, test } from "bun:test";
import { ConversationViewer, INITIAL_TRANSCRIPT_ENTRY_LIMIT } from "@/components/log-viewer/conversation-viewer";
import type { MessageData } from "@/types";
import { renderWithUser } from "../helpers/render";

function createMessage(index: number): MessageData {
  return {
    id: `message-${index}`,
    role: index % 2 === 0 ? "assistant" : "user",
    content: `Transcript message ${index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  };
}

describe("ConversationViewer", () => {
  test("renders a recent window for large transcripts and can load older entries", async () => {
    const messages = Array.from(
      { length: INITIAL_TRANSCRIPT_ENTRY_LIMIT + 50 },
      (_, index) => createMessage(index + 1),
    );

    const { getByRole, getByText, queryByText, user } = renderWithUser(
      <ConversationViewer
        messages={messages}
        logs={[]}
        toolCalls={[]}
        showAssistantMessages
        autoScroll={false}
      />,
    );

    expect(queryByText("Transcript message 1")).toBeNull();
    expect(getByText(`Transcript message ${messages.length}`)).toBeInTheDocument();

    await user.click(getByRole("button", { name: "Show 50 older entries" }));

    expect(getByText("Transcript message 1")).toBeInTheDocument();
    expect(getByText(`Transcript message ${messages.length}`)).toBeInTheDocument();
  });
});
