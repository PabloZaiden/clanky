import { describe, expect, test } from "bun:test";
import { ConversationViewer, INITIAL_TRANSCRIPT_ENTRY_LIMIT } from "@/components/log-viewer/conversation-viewer";
import type { MessageData } from "@/types";
import { act, renderWithUser } from "../helpers/render";
import { fireEvent } from "@testing-library/react";

function createMessage(index: number): MessageData {
  return {
    id: `message-${index}`,
    role: index % 2 === 0 ? "assistant" : "user",
    content: `Transcript message ${index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  };
}

function mockScrollMetrics(
  element: HTMLElement,
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => {
      metrics.scrollTop = value;
    },
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  });
}

async function flushAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
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
       />,
    );

    expect(queryByText("Transcript message 1")).toBeNull();
    expect(getByText(`Transcript message ${messages.length}`)).toBeInTheDocument();

    await user.click(getByRole("button", { name: /show \d+ older entries/i }));

    expect(getByText("Transcript message 1")).toBeInTheDocument();
    expect(getByText(`Transcript message ${messages.length}`)).toBeInTheDocument();
  });

  test("keeps following new content while already pinned to the bottom", async () => {
    const messages = [createMessage(1), createMessage(2)];
    const { container, rerender } = renderWithUser(
      <ConversationViewer
        id="conversation-scroll"
        messages={messages}
        logs={[]}
        toolCalls={[]}
        showAssistantMessages
      />,
    );
    const scrollContainer = container.querySelector("#conversation-scroll") as HTMLElement;
    const metrics = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
    mockScrollMetrics(scrollContainer, metrics);

    rerender(
      <ConversationViewer
        id="conversation-scroll"
        messages={[...messages, createMessage(3)]}
        logs={[]}
        toolCalls={[]}
        showAssistantMessages
      />,
    );
    metrics.scrollHeight = 1200;
    await flushAnimationFrame();

    expect(metrics.scrollTop).toBe(1200);
  });

  test("scrolls to the bottom on initial render before the user scrolls", async () => {
    const messages = [createMessage(1), createMessage(2)];
    const { container, rerender } = renderWithUser(
      <ConversationViewer
        id="conversation-scroll"
        messages={[]}
        logs={[]}
        toolCalls={[]}
        showAssistantMessages
      />,
    );
    const scrollContainer = container.querySelector("#conversation-scroll") as HTMLElement;
    const metrics = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 };
    mockScrollMetrics(scrollContainer, metrics);

    rerender(
      <ConversationViewer
        id="conversation-scroll"
        messages={messages}
        logs={[]}
        toolCalls={[]}
        showAssistantMessages
      />,
    );
    await flushAnimationFrame();

    expect(metrics.scrollTop).toBe(1000);
  });

  test("does not move when new content arrives after the user scrolls away from the bottom", async () => {
    const messages = [createMessage(1), createMessage(2)];
    const { container, rerender } = renderWithUser(
      <ConversationViewer
        id="conversation-scroll"
        messages={messages}
        logs={[]}
        toolCalls={[]}
        showAssistantMessages
      />,
    );
    const scrollContainer = container.querySelector("#conversation-scroll") as HTMLElement;
    const metrics = { scrollTop: 300, scrollHeight: 1000, clientHeight: 200 };
    mockScrollMetrics(scrollContainer, metrics);
    fireEvent.scroll(scrollContainer);

    rerender(
      <ConversationViewer
        id="conversation-scroll"
        messages={[...messages, createMessage(3)]}
        logs={[]}
        toolCalls={[]}
        showAssistantMessages
      />,
    );
    metrics.scrollHeight = 1200;
    await flushAnimationFrame();

    expect(metrics.scrollTop).toBe(300);
  });

  test("resumes following content after the user returns to the bottom", async () => {
    const messages = [createMessage(1), createMessage(2)];
    const { container, rerender } = renderWithUser(
      <ConversationViewer
        id="conversation-scroll"
        messages={messages}
        logs={[]}
        toolCalls={[]}
        showAssistantMessages
      />,
    );
    const scrollContainer = container.querySelector("#conversation-scroll") as HTMLElement;
    const metrics = { scrollTop: 300, scrollHeight: 1000, clientHeight: 200 };
    mockScrollMetrics(scrollContainer, metrics);
    fireEvent.scroll(scrollContainer);
    metrics.scrollTop = 800;
    fireEvent.scroll(scrollContainer);

    rerender(
      <ConversationViewer
        id="conversation-scroll"
        messages={[...messages, createMessage(3)]}
        logs={[]}
        toolCalls={[]}
        showAssistantMessages
      />,
    );
    metrics.scrollHeight = 1200;
    await flushAnimationFrame();

    expect(metrics.scrollTop).toBe(1200);
  });

  test("does not jump to the bottom when loading older entries while scrolled up", async () => {
    const messages = Array.from(
      { length: INITIAL_TRANSCRIPT_ENTRY_LIMIT + 50 },
      (_, index) => createMessage(index + 1),
    );
    const { container, getByRole, user } = renderWithUser(
      <ConversationViewer
        id="conversation-scroll"
        messages={messages}
        logs={[]}
        toolCalls={[]}
        showAssistantMessages
      />,
    );
    const scrollContainer = container.querySelector("#conversation-scroll") as HTMLElement;
    const metrics = { scrollTop: 100, scrollHeight: 1000, clientHeight: 200 };
    mockScrollMetrics(scrollContainer, metrics);
    fireEvent.scroll(scrollContainer);

    await user.click(getByRole("button", { name: /show \d+ older entries/i }));
    metrics.scrollHeight = 1400;
    await flushAnimationFrame();

    expect(metrics.scrollTop).toBe(100);
  });
});
