/**
 * Tests for the LogViewer component.
 *
 * LogViewer displays messages, tool calls, and application logs
 * in chronological order with auto-scroll behavior.
 */

import { test, expect, describe } from "bun:test";
import { ConversationViewer, LogViewer } from "@/components/LogViewer";
import type { LogEntry, LogViewerProps } from "@/components/LogViewer";
import { formatTime } from "@/components/log-viewer/utils";
import { renderWithUser } from "../helpers/render";
import {
  createMessageData,
  createToolCallData,
} from "../helpers/factories";
import type { MessageData } from "@/types";

// Helper to create a log entry
function createLogEntry(overrides?: Partial<LogEntry>): LogEntry {
  return {
    id: `log-${Date.now()}-${Math.random()}`,
    level: "info",
    message: "Test log message",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const SAME_MINUTE_TIME_A = "2026-04-09T16:42:01.000Z";
const SAME_MINUTE_TIME_B = "2026-04-09T16:42:45.000Z";
const NEXT_MINUTE_TIME = "2026-04-09T16:43:05.000Z";
const NEXT_DAY_SAME_VISIBLE_TIME = "2026-04-10T16:42:15.000Z";

describe("LogViewer", () => {
  describe("empty state", () => {
    test("renders empty state message when no entries", () => {
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} />
      );
      expect(getByText("No logs yet. Waiting for activity.")).toBeInTheDocument();
    });

    test("renders empty state when only empty arrays provided", () => {
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[]} />
      );
      expect(getByText("No logs yet. Waiting for activity.")).toBeInTheDocument();
    });

    test("shared conversation viewer accepts custom empty and active labels", () => {
      const rendered = renderWithUser(
        <ConversationViewer
          messages={[]}
          toolCalls={[]}
          emptyStateMessage="No conversation yet."
        />
      );
      expect(rendered.getByText("No conversation yet.")).toBeInTheDocument();

      rendered.rerender(
        <ConversationViewer
          messages={[]}
          toolCalls={[]}
          isActive={true}
          activeStateMessage="Responding..."
        />
      );
      expect(rendered.getByText("Responding...")).toBeInTheDocument();
    });

    test("uses vertical scrolling while hiding panel-level horizontal overflow", () => {
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[]} />
      );
      const root = container.firstElementChild as HTMLElement;
      expect(root.className).toContain("min-w-0");
      expect(root.className).toContain("overflow-x-hidden");
      expect(root.className).toContain("overflow-y-auto");
      expect(root.className).not.toContain("font-mono");
    });
  });

  describe("message rendering", () => {
    test("renders a user message", () => {
      const msg = createMessageData({ role: "user", content: "Hello world" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[]} />
      );
      const messageText = getByText("Hello world");
      expect(messageText).toBeInTheDocument();
      const messageGroup = messageText.closest("[data-message-role='user']") as HTMLElement | null;
      expect(messageGroup).not.toBeNull();
      expect(messageGroup?.textContent).toContain("Hello world");
      const bubble = messageGroup?.querySelector("[data-message-bubble='user']") as HTMLElement | null;
      expect(bubble).not.toBeNull();
      expect(bubble?.textContent).toContain("Hello world");
    });

    test("renders transient user image attachments", () => {
      const msg = createMessageData({
        role: "user",
        content: "Hello world",
        attachments: [{
          id: "img-1",
          filename: "screen.png",
          mimeType: "image/png",
          data: "ZmFrZQ==",
          size: 1234,
        }],
      });
      const { container, getByAltText } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[]} />
      );
      expect(getByAltText("screen.png")).toBeInTheDocument();
      expect(container.querySelector("img")?.getAttribute("src")).toContain("data:image/png;base64,ZmFrZQ==");
    });

    test("opens a larger preview when a message attachment is clicked", async () => {
      const msg = createMessageData({
        role: "user",
        content: "Hello world",
        attachments: [{
          id: "img-1",
          filename: "screen.png",
          mimeType: "image/png",
          data: "ZmFrZQ==",
          size: 1234,
        }],
      });

      const { getByLabelText, getByRole, queryByRole, user } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[]} />
      );

      await user.click(getByRole("button", { name: "View screen.png" }));

      expect(getByRole("dialog", { name: "screen.png" })).toBeInTheDocument();

      await user.click(getByLabelText("Close"));

      expect(queryByRole("dialog", { name: "screen.png" })).not.toBeInTheDocument();
    });

    test("shared conversation viewer can render assistant messages", () => {
      const msg = createMessageData({ role: "assistant", content: "I can help with that" });
      const { getByText } = renderWithUser(
        <ConversationViewer messages={[msg]} toolCalls={[]} showAssistantMessages={true} />
      );
      const assistantText = getByText("I can help with that");
      expect(assistantText).toBeInTheDocument();
      const messageGroup = assistantText.closest("[data-message-role='assistant']") as HTMLElement | null;
      expect(messageGroup).not.toBeNull();
      expect(messageGroup?.querySelector("[data-message-bubble]")).toBeNull();
    });

    test("shared conversation viewer can label message roles", () => {
      const msg = createMessageData({ role: "assistant", content: "Assistant answer" });
      const { getByText } = renderWithUser(
        <ConversationViewer
          messages={[msg]}
          toolCalls={[]}
          showAssistantMessages={true}
          showMessageRoles={true}
        />
      );
      expect(getByText("Assistant")).toBeInTheDocument();
      expect(getByText("Assistant answer")).toBeInTheDocument();
    });

    test("filters out assistant messages from display", () => {
      const msg = createMessageData({ role: "assistant", content: "I can help with that" });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[]} />
      );
      // Assistant messages are filtered out (their content is shown via AGENT response logs)
      expect(queryByText("assistant")).not.toBeInTheDocument();
      expect(queryByText("I can help with that")).not.toBeInTheDocument();
    });

    test("renders only user messages, filters out assistant messages", () => {
      const msgs: MessageData[] = [
        createMessageData({ role: "user", content: "First message" }),
        createMessageData({ role: "assistant", content: "Second message" }),
      ];
      const { getByText, queryByText } = renderWithUser(
        <LogViewer messages={msgs} toolCalls={[]} />
      );
      expect(getByText("First message")).toBeInTheDocument();
      // Assistant message is filtered out
      expect(queryByText("Second message")).not.toBeInTheDocument();
    });

    test("renders assistant markdown in shared conversation viewer", () => {
      const msg = createMessageData({ role: "assistant", content: "**bold text**" });
      const { getByText } = renderWithUser(
        <ConversationViewer
          messages={[msg]}
          toolCalls={[]}
          showAssistantMessages={true}
          markdownEnabled={true}
        />
      );
      expect(getByText("bold text")).toBeInTheDocument();
    });

    test("degrades streaming markdown assistant updates to the stable full render", () => {
      const assistantMessage = createMessageData({
        id: "assistant-markdown-streaming-message",
        role: "assistant",
        content: "**bo",
        timestamp: SAME_MINUTE_TIME_A,
      });
      const rendered = renderWithUser(
        <ConversationViewer
          messages={[assistantMessage]}
          toolCalls={[]}
          showAssistantMessages={true}
          markdownEnabled={true}
        />
      );

      rendered.rerender(
        <ConversationViewer
          messages={[{ ...assistantMessage, content: "**bold**" }]}
          toolCalls={[]}
          showAssistantMessages={true}
          markdownEnabled={true}
        />
      );

      const strong = rendered.container.querySelector("strong");
      expect(strong).not.toBeNull();
      expect(strong?.textContent).toBe("bold");
    });

    test("renders updated assistant message content without suffix animation markup", () => {
      const assistantMessage = createMessageData({
        id: "assistant-streaming-message",
        role: "assistant",
        content: "Thinking",
        timestamp: SAME_MINUTE_TIME_A,
      });
      const rendered = renderWithUser(
        <ConversationViewer
          messages={[assistantMessage]}
          toolCalls={[]}
          showAssistantMessages={true}
        />
      );

      rendered.rerender(
        <ConversationViewer
          messages={[{ ...assistantMessage, content: "Thinking a bit more" }]}
          toolCalls={[]}
          showAssistantMessages={true}
        />
      );

      expect(rendered.container.textContent).toContain("Thinking a bit more");
      expect(rendered.container.querySelector("[data-stream-suffix]")).toBeNull();

      rendered.rerender(
        <ConversationViewer
          messages={[{ ...assistantMessage, content: "Thinking a bit more again" }]}
          toolCalls={[]}
          showAssistantMessages={true}
        />
      );

      expect(rendered.container.textContent).toContain("Thinking a bit more again");
      expect(rendered.container.querySelector("[data-stream-suffix]")).toBeNull();
    });

    test("renders updated user message content without suffix animation markup", () => {
      const userMessage = createMessageData({
        id: "user-message-static",
        role: "user",
        content: "First draft",
        timestamp: SAME_MINUTE_TIME_A,
      });
      const rendered = renderWithUser(
        <ConversationViewer messages={[userMessage]} toolCalls={[]} showAssistantMessages={true} />
      );

      rendered.rerender(
        <ConversationViewer
          messages={[{ ...userMessage, content: "First draft updated" }]}
          toolCalls={[]}
          showAssistantMessages={true}
        />
      );

      expect(rendered.container.textContent).toContain("First draft updated");
      expect(rendered.container.querySelector("[data-stream-suffix]")).toBeNull();
    });

    test("user messages are always shown regardless of filter settings", () => {
      const msgs: MessageData[] = [
        createMessageData({ role: "user", content: "User msg" }),
        createMessageData({ role: "assistant", content: "Assistant msg" }),
      ];
      const { getByText, queryByText } = renderWithUser(
        <LogViewer messages={msgs} toolCalls={[]} showSystemInfo={false} showReasoning={false} showTools={false} />
      );
      expect(getByText("User msg")).toBeInTheDocument();
      // Assistant messages are always filtered out
      expect(queryByText("Assistant msg")).not.toBeInTheDocument();
    });

    test("shared conversation viewer hides repeated visible timestamps for same-minute messages", () => {
      const firstMessage = createMessageData({
        role: "user",
        content: "First chat line",
        timestamp: SAME_MINUTE_TIME_A,
      });
      const secondMessage = createMessageData({
        role: "assistant",
        content: "Second chat line",
        timestamp: SAME_MINUTE_TIME_B,
      });

      const visibleTime = formatTime(SAME_MINUTE_TIME_A);
      const { container, getByText, getAllByText } = renderWithUser(
        <ConversationViewer
          messages={[firstMessage, secondMessage]}
          toolCalls={[]}
          showAssistantMessages={true}
        />
      );

      expect(getByText("First chat line")).toBeInTheDocument();
      expect(getByText("Second chat line")).toBeInTheDocument();
      expect(getAllByText(visibleTime)).toHaveLength(1);
      expect(container.querySelectorAll("time")).toHaveLength(1);
    });

    test("shared conversation viewer shows a new timestamp when the displayed time changes", () => {
      const firstMessage = createMessageData({
        role: "user",
        content: "Earlier chat line",
        timestamp: SAME_MINUTE_TIME_A,
      });
      const secondMessage = createMessageData({
        role: "assistant",
        content: "Later chat line",
        timestamp: NEXT_MINUTE_TIME,
      });

      const { container, getAllByText } = renderWithUser(
        <ConversationViewer
          messages={[firstMessage, secondMessage]}
          toolCalls={[]}
          showAssistantMessages={true}
        />
      );

      expect(getAllByText(formatTime(SAME_MINUTE_TIME_A))).toHaveLength(1);
      expect(getAllByText(formatTime(NEXT_MINUTE_TIME))).toHaveLength(1);
      expect(container.querySelectorAll("time")).toHaveLength(2);
    });

    test("shared conversation viewer keeps timestamps on different days even when hh:mm matches", () => {
      const firstMessage = createMessageData({
        role: "user",
        content: "First day chat line",
        timestamp: SAME_MINUTE_TIME_A,
      });
      const secondMessage = createMessageData({
        role: "assistant",
        content: "Second day chat line",
        timestamp: NEXT_DAY_SAME_VISIBLE_TIME,
      });

      const visibleTime = formatTime(SAME_MINUTE_TIME_A);
      const { container, getAllByText } = renderWithUser(
        <ConversationViewer
          messages={[firstMessage, secondMessage]}
          toolCalls={[]}
          showAssistantMessages={true}
        />
      );

      expect(getAllByText(visibleTime)).toHaveLength(2);
      expect(container.querySelectorAll("time")).toHaveLength(2);
    });
  });

  describe("tool call rendering", () => {
    function renderToolCall(overrides?: Partial<ReturnType<typeof createToolCallData>>) {
      return renderToolCallWithViewerProps(overrides);
    }

    function renderToolCallWithViewerProps(
      overrides?: Partial<ReturnType<typeof createToolCallData>>,
      viewerProps?: Partial<LogViewerProps>,
    ) {
      return renderWithUser(
        <LogViewer
          messages={[]}
          toolCalls={[createToolCallData(overrides)]}
          showTools={true}
          {...viewerProps}
        />
      );
    }

    test("infers view from a path-only payload and renders text output", async () => {
      const { getByText, queryByText, user } = renderToolCall({
        name: "read",
        input: { path: "/src/file.ts" },
        output: { content: "file contents here" },
      });

      expect(queryByText("file contents here")).not.toBeInTheDocument();
      await user.click(getByText("View /src/file.ts"));
      expect(getByText("file contents here")).toBeInTheDocument();
    });

    test("infers view from a legacy filePath payload", () => {
      const { getByText } = renderToolCall({
        name: "read",
        input: { filePath: "/src/legacy-file.ts" },
      });

      expect(getByText("View /src/legacy-file.ts")).toBeInTheDocument();
    });

    test("infers view from path plus view_range", () => {
      const { getByText } = renderToolCall({
        name: "read",
        input: { path: "/tmp/pr391.html", "view_range": [6260, 6375] },
      });

      expect(getByText("View /tmp/pr391.html:6260-6375")).toBeInTheDocument();
    });

    test("keeps inferring view for file-target payload variants with extra metadata", () => {
      const { getByText } = renderToolCall({
        name: "read",
        input: { filePath: "/src/legacy-file.ts", encoding: "utf-8" },
      });

      expect(getByText("View /src/legacy-file.ts")).toBeInTheDocument();
    });

    test("renders view paths relative to the active display root", () => {
      const { getByText } = renderToolCallWithViewerProps(
        {
          name: "read",
          input: { path: "/workspaces/demo/repo/src/file.ts" },
        },
        {
          toolPathDisplayRoot: "/workspaces/demo/repo",
        }
      );

      expect(getByText("View src/file.ts")).toBeInTheDocument();
    });

    test("keeps absolute view paths when they are outside the active display root", () => {
      const { getByText } = renderToolCallWithViewerProps(
        {
          name: "read",
          input: { path: "/tmp/pr391.html", "view_range": [6260, 6375] },
        },
        {
          toolPathDisplayRoot: "/workspaces/demo/repo",
        }
      );

      expect(getByText("View /tmp/pr391.html:6260-6375")).toBeInTheDocument();
    });

    test("infers glob from a pattern-only payload", () => {
      const { getByText } = renderToolCall({
        name: "read",
        input: { pattern: "src/**/*{Chat,chat,Message,message}*.tsx" },
      });

      expect(getByText("Find files matching 'src/**/*{Chat,chat,Message,message}*.tsx'")).toBeInTheDocument();
    });

    test("infers glob from pattern plus path when no rg flags are present", () => {
      const { getByText } = renderToolCall({
        name: "read",
        input: { pattern: "**/AGENTS.md", path: "/workspaces/demo/repo" },
      });

      expect(getByText("Find files matching '**/AGENTS.md' in /workspaces/demo/repo")).toBeInTheDocument();
    });

    test("infers rg from pattern plus rg-style flags", () => {
      const { getByText } = renderToolCall({
        name: "other",
        input: {
          pattern: "API_TOKEN_SCOPE",
          path: "/workspaces/demo/repo",
          output_mode: "content",
          "-n": true,
        },
      });

      expect(getByText("Search for 'API_TOKEN_SCOPE' in /workspaces/demo/repo")).toBeInTheDocument();
    });

    test("infers apply_patch from raw patch-string input and preserves the raw patch in details", async () => {
      const patch = [
        "*** Begin Patch",
        "*** Update File: src/example.ts",
        "@@",
        "-const before = true;",
        "+const after = true;",
        "*** End Patch",
      ].join("\n");
      const { container, getByText, queryByText, user } = renderToolCall({
        name: "edit",
        input: patch,
      });

      expect(queryByText("-const before = true;")).not.toBeInTheDocument();
      await user.click(getByText("Patch src/example.ts"));
      expect(container.textContent).toContain("-const before = true;");
      expect(container.textContent).toContain("+const after = true;");
    });

    test("infers bash from command payloads and prefers description in the summary", () => {
      const { getByText } = renderToolCall({
        name: "execute",
        input: {
          command: "bun run build && bun run test",
          description: "Run checks",
          initial_wait: 180,
        },
      });

      expect(getByText("Run checks")).toBeInTheDocument();
    });

    test("infers read_bash from shellId plus delay", () => {
      const { getByText } = renderToolCall({
        name: "read",
        input: { shellId: "3", delay: 120 },
      });

      expect(getByText("Read shell output (shell 3)")).toBeInTheDocument();
    });

    test("infers write_bash from shellId plus input plus delay", () => {
      const { getByText } = renderToolCall({
        name: "edit",
        input: { shellId: "24", input: "y\n", delay: 120 },
      });

      expect(getByText("Send input to shell 24: \"y\"")).toBeInTheDocument();
    });

    test("infers sql from description plus query", () => {
      const { getByText } = renderToolCall({
        name: "other",
        input: {
          description: "Seed PR 391 todos",
          query: "INSERT OR REPLACE INTO todos VALUES ('1')",
        },
      });

      expect(getByText("Seed PR 391 todos")).toBeInTheDocument();
    });

    test("infers github_mcp from method plus owner plus repo payloads", () => {
      const { getByText } = renderToolCall({
        name: "read",
        input: { method: "get_reviews", owner: "microsoft", repo: "MyProject", pullNumber: 391 },
      });

      expect(getByText("GitHub MyProject#391 get_reviews")).toBeInTheDocument();
    });

    test("renders github_mcp object output as JSON", async () => {
      const { container, getByText, user } = renderToolCall({
        name: "read",
        input: { method: "get", owner: "microsoft", repo: "MyProject", pullNumber: 391 },
        output: { message: "ok", reviews: 2 },
      });

      await user.click(getByText("GitHub MyProject#391 get"));
      const outputPre = Array.from(container.querySelectorAll("pre")).find(
        (element) => element.textContent?.includes('"reviews": 2')
      );
      expect(outputPre).toBeDefined();
      expect(outputPre?.textContent).toContain('"message": "ok"');
    });

    test("infers web_fetch from a url payload", () => {
      const { getByText } = renderToolCall({
        name: "fetch",
        input: { url: "https://github.com/microsoft/MyProject/pull/391", max_length: 20000 },
      });

      expect(getByText("Fetch https://github.com/microsoft/MyProject/pull/391")).toBeInTheDocument();
    });

    test("infers skill from a skill payload", () => {
      const { getByText } = renderToolCall({
        name: "other",
        input: { skill: "playwright-cli" },
      });

      expect(getByText("Load skill playwright-cli")).toBeInTheDocument();
    });

    test("falls back to an unknown summary for empty payloads", () => {
      const { getByText } = renderToolCall({
        name: "execute",
        input: {},
      });

      expect(getByText("Unknown tool (stored as execute)")).toBeInTheDocument();
    });

    test("misleading stored names do not override read_bash inference", () => {
      const { getByText, queryByText } = renderToolCall({
        name: "read",
        input: { shellId: "3", delay: 120 },
      });

      expect(getByText("Read shell output (shell 3)")).toBeInTheDocument();
      expect(queryByText("View file")).not.toBeInTheDocument();
    });

    test("misleading stored names do not override sql inference", () => {
      const { getByText, queryByText } = renderToolCall({
        name: "other",
        input: { description: "Seed PR 391 todos", query: "SELECT 1" },
      });

      expect(getByText("Seed PR 391 todos")).toBeInTheDocument();
      expect(queryByText("Unknown tool (stored as other)")).not.toBeInTheDocument();
    });

    test("misleading stored names do not override apply_patch inference", () => {
      const patch = [
        "*** Begin Patch",
        "*** Update File: src/feature.ts",
        "@@",
        "-oldValue();",
        "+newValue();",
        "*** End Patch",
      ].join("\n");
      const { getByText, queryByText } = renderToolCall({
        name: "edit",
        input: patch,
      });

      expect(getByText("Patch src/feature.ts")).toBeInTheDocument();
      expect(queryByText("Unknown tool (stored as edit)")).not.toBeInTheDocument();
    });

    test("keeps tool detail content mounted after first expansion", async () => {
      const { getByText, queryByText, user } = renderToolCall({
        name: "execute",
        input: { path: "/src/file.ts" },
        output: { content: "file contents here" },
      });
      const summaryText = getByText("View /src/file.ts");
      const disclosure = summaryText.closest("[data-open]") as HTMLElement | null;

      expect(queryByText("file contents here")).not.toBeInTheDocument();
      await user.click(summaryText);
      expect(getByText("file contents here")).toBeInTheDocument();
      expect(disclosure?.getAttribute("data-open")).toBe("true");

      await user.click(summaryText);
      expect(queryByText("file contents here")).toBeInTheDocument();
      expect(disclosure?.getAttribute("data-open")).toBe("false");
    });

    test("styles tool summaries as accent-colored transcript entries", () => {
      const { getByText } = renderToolCall({
        name: "execute",
        input: {},
      });

      const summaryText = getByText("Unknown tool (stored as execute)");
      const toolEntry = summaryText.closest(".group") as HTMLElement;
      expect(toolEntry).not.toBeNull();
      expect(toolEntry.getAttribute("data-entry-type")).toBe("tool");
      expect(summaryText.className).toContain("text-sm");
      expect(summaryText.className).toContain("text-sky-300");
    });

    test("renders parsed tool input above the output panel", async () => {
      const { getByText, user } = renderToolCall({
        name: "execute",
        input: { path: "/src/file.ts" },
        output: { content: "file contents here" },
      });

      await user.click(getByText("View /src/file.ts"));
      expect(getByText("Input")).toBeInTheDocument();
      expect(getByText("Result")).toBeInTheDocument();
      expect(getByText("file contents here")).toBeInTheDocument();
    });

    test("hides tool calls when showTools is false", () => {
      const tool = createToolCallData({
        name: "read",
        input: { path: "/src/file.ts" },
      });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={false} />
      );

      expect(queryByText("View /src/file.ts")).not.toBeInTheDocument();
    });

    test("always renders summary lines for consecutive unknown pending tools", () => {
      const firstTool = createToolCallData({
        name: "execute",
        input: {},
        output: undefined,
        status: "pending",
      });
      const secondTool = createToolCallData({
        name: "execute",
        input: {},
        output: undefined,
        status: "running",
      });
      const { getAllByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[firstTool, secondTool]} showTools={true} />
      );

      expect(getAllByText("Unknown tool (stored as execute)")).toHaveLength(2);
    });
  });

  describe("log entry rendering", () => {
    test("renders an info log when showSystemInfo is true", () => {
      const log = createLogEntry({ level: "info", message: "Server started" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showSystemInfo={true} />
      );
      expect(getByText("Server started")).toBeInTheDocument();
    });

    test("renders a warn log when showSystemInfo is true", () => {
      const log = createLogEntry({ level: "warn", message: "Rate limit approaching" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showSystemInfo={true} />
      );
      expect(getByText("Rate limit approaching")).toBeInTheDocument();
    });

    test("renders an error log when showSystemInfo is true", () => {
      const log = createLogEntry({ level: "error", message: "Connection failed" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showSystemInfo={true} />
      );
      expect(getByText("Connection failed")).toBeInTheDocument();
    });

    test("renders a debug log when showSystemInfo is true", () => {
      const log = createLogEntry({ level: "debug", message: "Debug info" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showSystemInfo={true} />
      );
      expect(getByText("Debug info")).toBeInTheDocument();
    });

    test("renders an agent log", () => {
      const log = createLogEntry({ level: "agent", message: "Agent thinking" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(getByText("Agent thinking")).toBeInTheDocument();
    });

    test("loop log viewer hides repeated visible timestamps while keeping distinct log labels", () => {
      const firstLog = createLogEntry({
        id: "log-same-minute-a",
        level: "agent",
        message: "First loop log",
        timestamp: SAME_MINUTE_TIME_A,
      });
      const secondLog = createLogEntry({
        id: "log-same-minute-b",
        level: "agent",
        message: "Second loop log",
        timestamp: SAME_MINUTE_TIME_B,
      });

      const visibleTime = formatTime(SAME_MINUTE_TIME_A);
      const { container, getByText, getAllByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[firstLog, secondLog]} />
      );

      expect(getByText("First loop log")).toBeInTheDocument();
      expect(getByText("Second loop log")).toBeInTheDocument();
      expect(getAllByText(visibleTime)).toHaveLength(1);
      expect(container.querySelectorAll("time")).toHaveLength(1);
    });

    test("loop log viewer shows the timestamp again after the displayed minute changes", () => {
      const firstLog = createLogEntry({
        id: "log-next-minute-a",
        level: "agent",
        message: "First minute log",
        timestamp: SAME_MINUTE_TIME_A,
      });
      const secondLog = createLogEntry({
        id: "log-next-minute-b",
        level: "agent",
        message: "Next minute log",
        timestamp: NEXT_MINUTE_TIME,
      });

      const { container, getAllByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[firstLog, secondLog]} />
      );

      expect(getAllByText(formatTime(SAME_MINUTE_TIME_A))).toHaveLength(1);
      expect(getAllByText(formatTime(NEXT_MINUTE_TIME))).toHaveLength(1);
      expect(container.querySelectorAll("time")).toHaveLength(2);
    });

    test("loop log viewer keeps timestamps on different days even when hh:mm matches", () => {
      const firstLog = createLogEntry({
        id: "log-next-day-a",
        level: "agent",
        message: "First day loop log",
        timestamp: SAME_MINUTE_TIME_A,
      });
      const secondLog = createLogEntry({
        id: "log-next-day-b",
        level: "agent",
        message: "Second day loop log",
        timestamp: NEXT_DAY_SAME_VISIBLE_TIME,
      });

      const visibleTime = formatTime(SAME_MINUTE_TIME_A);
      const { container, getAllByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[firstLog, secondLog]} />
      );

      expect(getAllByText(visibleTime)).toHaveLength(2);
      expect(container.querySelectorAll("time")).toHaveLength(2);
    });

    test("renders log details in collapsible section", async () => {
      const log = createLogEntry({
        level: "agent",
        details: { key: "value", count: 42 },
      });
      const { container, getByRole, user } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      const detailsButton = getByRole("button", { name: "Details" });
      expect(detailsButton).toBeInTheDocument();
      const panelId = detailsButton.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      const detailsPanel = panelId ? container.querySelector(`#${panelId}`) as HTMLElement | null : null;
      expect(detailsPanel).not.toBeNull();
      expect(detailsPanel?.getAttribute("aria-labelledby")).toBe(detailsButton.id);
      expect(container.querySelectorAll("pre")).toHaveLength(0);
      await user.click(detailsButton);
      const detailsPre = Array.from(container.querySelectorAll("pre")).find(
        (element) => element.textContent?.includes("\"key\": \"value\"")
      );
      expect(detailsPre).toBeDefined();
    });

    test("does not render Details when log has no details", () => {
      const log = createLogEntry({ level: "agent", details: undefined });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(queryByText("Details")).not.toBeInTheDocument();
    });

    test("renders responseContent as text block, not in Details", () => {
      const log = createLogEntry({
        level: "agent",
        details: { logKind: "response", responseContent: "AI response text here" },
      });
      const { getByText, queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      // responseContent should be rendered as text
      expect(getByText("AI response text here")).toBeInTheDocument();
      // Should NOT show Details since responseContent and logKind are filtered out
      expect(queryByText("Details")).not.toBeInTheDocument();
    });

    test("renders responseContent and other details separately", () => {
      const log = createLogEntry({
        level: "agent",
        details: {
          logKind: "response",
          responseContent: "AI response",
          otherKey: "otherValue",
        },
      });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      // responseContent as text block
      expect(getByText("AI response")).toBeInTheDocument();
      // Other details in collapsible
      expect(getByText("Details")).toBeInTheDocument();
    });

    test("renders a newly visible streamed response row as static content", async () => {
      const firstResponse = createLogEntry({
        id: "response-log-enter-a",
        level: "agent",
        message: "AI generating response...",
        timestamp: SAME_MINUTE_TIME_A,
        details: { logKind: "response", responseContent: "First response" },
      });
      const secondResponse = createLogEntry({
        id: "response-log-enter-b",
        level: "agent",
        message: "AI generating response...",
        timestamp: NEXT_MINUTE_TIME,
        details: { logKind: "response", responseContent: "Second response" },
      });
      const rendered = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[firstResponse]} />
      );

      rendered.rerender(
        <LogViewer messages={[]} toolCalls={[]} logs={[firstResponse, secondResponse]} />
      );

      expect(rendered.container.textContent).toContain("Second response");
      expect(rendered.container.querySelector("[data-stream-suffix]")).toBeNull();
    });

    test("renders appended streamed response content without suffix animation markup", () => {
      const responseLog = createLogEntry({
        id: "response-log-update",
        level: "agent",
        message: "AI generating response...",
        timestamp: SAME_MINUTE_TIME_A,
        details: { logKind: "response", responseContent: "Hello" },
      });
      const rendered = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[responseLog]} />
      );

      rendered.rerender(
        <LogViewer
          messages={[]}
          toolCalls={[]}
          logs={[{
            ...responseLog,
            details: { logKind: "response", responseContent: "Hello world" },
          }]}
        />
      );

      expect(rendered.container.textContent).toContain("Hello world");
      expect(rendered.container.querySelector("[data-stream-suffix]")).toBeNull();

      rendered.rerender(
        <LogViewer
          messages={[]}
          toolCalls={[]}
          logs={[{
            ...responseLog,
            details: { logKind: "response", responseContent: "Hello world again" },
          }]}
        />
      );

      expect(rendered.container.textContent).toContain("Hello world again");
      expect(rendered.container.querySelector("[data-stream-suffix]")).toBeNull();
    });

    test("renders legacy streamed response content without suffix animation markup", () => {
      const legacyResponseLog = createLogEntry({
        id: "legacy-response-log-update",
        level: "agent",
        message: "AI generating response...",
        timestamp: SAME_MINUTE_TIME_A,
        details: { responseContent: "Legacy" },
      });
      const rendered = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[legacyResponseLog]} />
      );

      rendered.rerender(
        <LogViewer
          messages={[]}
          toolCalls={[]}
          logs={[{
            ...legacyResponseLog,
            details: { responseContent: "Legacy response" },
          }]}
        />
      );

      expect(rendered.container.textContent).toContain("Legacy response");
      expect(rendered.container.querySelector("[data-stream-suffix]")).toBeNull();
    });
  });

  describe("system info filtering", () => {
    test("hides info/warn/error/debug/trace logs by default (showSystemInfo=false)", () => {
      const logs = [
        createLogEntry({ level: "info", message: "Info msg" }),
        createLogEntry({ level: "warn", message: "Warn msg" }),
        createLogEntry({ level: "error", message: "Error msg" }),
        createLogEntry({ level: "debug", message: "Debug msg" }),
      ];
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={logs} />
      );
      expect(queryByText("Info msg")).not.toBeInTheDocument();
      expect(queryByText("Warn msg")).not.toBeInTheDocument();
      expect(queryByText("Error msg")).not.toBeInTheDocument();
      expect(queryByText("Debug msg")).not.toBeInTheDocument();
    });

    test("shows all logs when showSystemInfo=true", () => {
      const logs = [
        createLogEntry({ level: "info", message: "Info msg" }),
        createLogEntry({ level: "warn", message: "Warn msg" }),
        createLogEntry({ level: "error", message: "Error msg" }),
        createLogEntry({ level: "debug", message: "Debug msg" }),
      ];
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={logs} showSystemInfo={true} />
      );
      expect(getByText("Info msg")).toBeInTheDocument();
      expect(getByText("Warn msg")).toBeInTheDocument();
      expect(getByText("Error msg")).toBeInTheDocument();
      expect(getByText("Debug msg")).toBeInTheDocument();
    });

    test("hides system agent logs (logKind=system) by default", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI started generating response",
        details: { logKind: "system" },
      });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(queryByText("AI started generating response")).not.toBeInTheDocument();
    });

    test("shows system agent logs when showSystemInfo=true", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI started generating response",
        details: { logKind: "system" },
      });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showSystemInfo={true} />
      );
      expect(getByText("AI started generating response")).toBeInTheDocument();
    });

    test("shows empty state when only system logs exist and showSystemInfo=false", () => {
      const logs = [
        createLogEntry({ level: "debug", message: "Debug only" }),
      ];
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={logs} />
      );
      expect(getByText("No logs yet. Waiting for activity.")).toBeInTheDocument();
    });

    test("backward compat: hides old agent entries matching system patterns when showSystemInfo=false", () => {
      // Old entries without logKind that match system patterns
      const log = createLogEntry({
        level: "agent",
        message: "AI started generating response",
        // No logKind in details
      });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(queryByText("AI started generating response")).not.toBeInTheDocument();
    });
  });

  describe("reasoning filtering", () => {
    test("shows reasoning entries by default (showReasoning defaults to true)", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI reasoning...",
        details: { logKind: "reasoning", responseContent: "thinking about it" },
      });
      const { getByText, queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(queryByText("AI reasoning...")).not.toBeInTheDocument();
      expect(getByText("thinking about it")).toBeInTheDocument();
    });

    test("hides reasoning entries when showReasoning=false", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI reasoning...",
        details: { logKind: "reasoning", responseContent: "thinking about it" },
      });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showReasoning={false} />
      );
      expect(queryByText("AI reasoning...")).not.toBeInTheDocument();
    });

    test("shows reasoning entries when showReasoning=true", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI reasoning...",
        details: { logKind: "reasoning", responseContent: "thinking about it" },
      });
      const { getByText, queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showReasoning={true} />
      );
      expect(queryByText("AI reasoning...")).not.toBeInTheDocument();
      expect(getByText("thinking about it")).toBeInTheDocument();
    });

    test("backward compat: shows old reasoning by default when no logKind", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI reasoning...",
        details: { responseContent: "old reasoning content" },
      });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(getByText("AI reasoning...")).toBeInTheDocument();
    });

    test("backward compat: hides old reasoning when showReasoning=false", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI reasoning...",
        details: { responseContent: "old reasoning content" },
      });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showReasoning={false} />
      );
      expect(queryByText("AI reasoning...")).not.toBeInTheDocument();
    });

    test("backward compat: shows old reasoning when showReasoning=true", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI reasoning...",
        details: { responseContent: "old reasoning content" },
      });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showReasoning={true} />
      );
      expect(getByText("AI reasoning...")).toBeInTheDocument();
    });
  });

  describe("reasoning styling", () => {
    test("renders reasoning entries as lighter plain transcript text without a boxed background", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI reasoning...",
        details: { logKind: "reasoning", responseContent: "thinking" },
      });
      const { container, getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showReasoning={true} />
      );
      const group = container.querySelector("[data-log-kind='reasoning']") as HTMLElement | null;
      expect(group).not.toBeNull();
      const reasoningBody = group?.querySelector("[data-log-tone='reasoning']") as HTMLElement | null;
      expect(reasoningBody).not.toBeNull();
      expect(reasoningBody?.querySelector("[data-dimmed='false']")).not.toBeNull();
      expect(getByText("thinking")).toBeInTheDocument();
      expect(group?.querySelector("pre")).toBeNull();
    });

    test("keeps markdown reasoning at the same non-dimmed level as plain reasoning", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI reasoning...",
        details: { logKind: "reasoning", responseContent: "**thinking**" },
      });
      const { container, getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showReasoning={true} markdownEnabled={true} />
      );
      const group = container.querySelector("[data-log-kind='reasoning']") as HTMLElement | null;
      expect(group).not.toBeNull();
      const reasoningBody = group?.querySelector("[data-log-tone='reasoning']") as HTMLElement | null;
      expect(reasoningBody).not.toBeNull();
      expect(reasoningBody?.querySelector("[data-dimmed='false']")).not.toBeNull();
      expect(getByText("thinking")).toBeInTheDocument();
    });

    test("does not apply reasoning styling to response entries", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI generating response...",
        details: { logKind: "response", responseContent: "hello world" },
      });
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      const group = container.querySelector("[data-log-kind='response']") as HTMLElement | null;
      expect(group).not.toBeNull();
      const responseBody = group?.querySelector("[data-log-tone='agent']") as HTMLElement | null;
      expect(responseBody).not.toBeNull();
      expect(responseBody?.querySelector("[data-dimmed='false']")).not.toBeNull();
    });
  });

  describe("tools filtering", () => {
    test("shows tool call entries by default", () => {
      const tool = createToolCallData({ name: "read", input: { path: "/src/file.ts" }, status: "completed" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} />
      );
      expect(getByText("View /src/file.ts")).toBeInTheDocument();
    });

    test("hides tool call entries when showTools=false", () => {
      const tool = createToolCallData({ name: "read", input: { path: "/src/file.ts" }, status: "completed" });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={false} />
      );
      expect(queryByText("View /src/file.ts")).not.toBeInTheDocument();
    });

    test("shows tool call entries when showTools=true", () => {
      const tool = createToolCallData({ name: "read", input: { path: "/src/file.ts" }, status: "completed" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={true} />
      );
      expect(getByText("View /src/file.ts")).toBeInTheDocument();
    });

    test("hides tool-related agent logs by default (showTools=false)", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI calling tool: Write",
        details: { logKind: "tool" },
      });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(queryByText("AI calling tool: Write")).not.toBeInTheDocument();
    });

    test("always suppresses tool-related agent logs even when showTools=true", () => {
      // Legacy "AI calling tool:" log entries are always hidden; the rich ToolEntry replaces them.
      const log = createLogEntry({
        level: "agent",
        message: "AI calling tool: Write",
        details: { logKind: "tool" },
      });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showTools={true} />
      );
      expect(queryByText("AI calling tool: Write")).not.toBeInTheDocument();
    });

    test("backward compat: identifies tool logs by message text when no logKind", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI calling tool: Bash",
      });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(queryByText("AI calling tool: Bash")).not.toBeInTheDocument();
    });
  });

  describe("response entries always shown", () => {
    test("response entries (logKind=response) are always shown", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI generating response...",
        details: { logKind: "response", responseContent: "Hello world" },
      });
      const { getByText, queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(queryByText("AI generating response...")).not.toBeInTheDocument();
      expect(getByText("Hello world")).toBeInTheDocument();
    });

    test("backward compat: response entries without logKind are always shown", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI generating response...",
        details: { responseContent: "Hello world" },
      });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(getByText("AI generating response...")).toBeInTheDocument();
    });

    test("response entries with empty responseContent are filtered out", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI generating response...",
        details: { logKind: "response", responseContent: "" },
      });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(queryByText("AI generating response...")).not.toBeInTheDocument();
    });

    test("response entries with no responseContent are filtered out", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI generating response...",
        details: { logKind: "response" },
      });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(queryByText("AI generating response...")).not.toBeInTheDocument();
    });

    test("reasoning entries with empty responseContent are filtered out", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI reasoning...",
        details: { logKind: "reasoning", responseContent: "" },
      });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showReasoning={true} />
      );
      expect(queryByText("AI reasoning...")).not.toBeInTheDocument();
    });

    test("reasoning entries with no responseContent are filtered out", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI reasoning...",
        details: { logKind: "reasoning" },
      });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showReasoning={true} />
      );
      expect(queryByText("AI reasoning...")).not.toBeInTheDocument();
    });
  });

  describe("chronological sorting", () => {
    test("sorts entries by timestamp across all types", () => {
      const msg = createMessageData({
        role: "user",
        content: "Second entry",
        timestamp: "2026-01-01T00:00:02.000Z",
      });
      const tool = createToolCallData({
        name: "FirstTool",
        timestamp: "2026-01-01T00:00:01.000Z",
      });
      const log = createLogEntry({
        level: "agent",
        message: "Third entry",
        timestamp: "2026-01-01T00:00:03.000Z",
      });

      const { container } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[tool]} logs={[log]} showTools={true} />
      );

      // Get all rendered entry groups
      const groups = container.querySelectorAll(".group");
      expect(groups.length).toBe(3);

      // Verify order: tool summary (01), second entry (02), third entry (03)
      expect(groups[0]?.textContent).toContain("View /src/test.ts");
      expect(groups[1]?.textContent).toContain("Second entry");
      expect(groups[2]?.textContent).toContain("Third entry");
    });

    test("renders message, tool, and log timestamps as hh:mm only", () => {
      const msg = createMessageData({
        role: "user",
        content: "Message entry",
        timestamp: "2026-01-01T00:00:02.000Z",
      });
      const tool = createToolCallData({
        name: "Write",
        timestamp: "2026-01-01T00:01:01.000Z",
      });
      const log = createLogEntry({
        level: "agent",
        message: "Log entry",
        timestamp: "2026-01-01T00:02:03.000Z",
      });

      const { container } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[tool]} logs={[log]} showTools={true} />
      );

      const groups = Array.from(container.querySelectorAll(".group"));
      expect(groups).toHaveLength(3);

      groups.forEach((group) => {
        const timeEl = group.querySelector("time");
        expect(timeEl).not.toBeNull();
        const timestampText = timeEl?.textContent ?? "";
        expect(timestampText).toMatch(/^\d{2}:\d{2}$/);
      });
    });
  });

  describe("props", () => {
    test("sets id on the root element", () => {
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} id="log-viewer-1" />
      );
      const el = container.querySelector("#log-viewer-1");
      expect(el).toBeInTheDocument();
    });

    test("applies maxHeight style when provided", () => {
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} maxHeight="400px" />
      );
      const root = container.firstElementChild as HTMLElement;
      expect(root.style.maxHeight).toBe("400px");
    });

    test("does not apply maxHeight style when not provided", () => {
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} />
      );
      const root = container.firstElementChild as HTMLElement;
      expect(root.style.maxHeight).toBe("");
    });

    test("applies flex-1 class when no maxHeight", () => {
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} />
      );
      const root = container.firstElementChild as HTMLElement;
      expect(root.className).toContain("flex-1");
    });

    test("does not apply flex-1 class when maxHeight is set", () => {
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} maxHeight="400px" />
      );
      const root = container.firstElementChild as HTMLElement;
      expect(root.className).not.toContain("flex-1");
    });
  });

  describe("mixed content", () => {
    test("renders messages, tool calls, and logs together", () => {
      const messages = [createMessageData({ content: "Hello from user", role: "user" })];
      const toolCalls = [createToolCallData({ name: "read", status: "completed", input: { path: "/src/work.ts" } })];
      const logs = [createLogEntry({ level: "info", message: "Processing complete" })];

      const { getByText } = renderWithUser(
        <LogViewer messages={messages} toolCalls={toolCalls} logs={logs} showTools={true} showSystemInfo={true} />
      );

      expect(getByText("Hello from user")).toBeInTheDocument();
      expect(getByText("View /src/work.ts")).toBeInTheDocument();
      expect(getByText("Processing complete")).toBeInTheDocument();
    });
  });

  describe("markdown rendering", () => {
    test("assistant messages are filtered out even when markdownEnabled is not set", () => {
      const msg = createMessageData({ role: "assistant", content: "**bold text**" });
      const { container } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[]} />
      );
      // Assistant messages are filtered out entirely
      expect(container.textContent).not.toContain("**bold text**");
    });

    test("assistant messages are filtered out even when markdownEnabled is true", () => {
      const msg = createMessageData({ role: "assistant", content: "**bold text**" });
      const { container } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[]} markdownEnabled={true} />
      );
      // Assistant messages are filtered out entirely
      expect(container.querySelector("strong")).toBeNull();
      expect(container.textContent).not.toContain("bold text");
    });

    test("renders user message as plain text even when markdownEnabled is true", () => {
      const msg = createMessageData({ role: "user", content: "**not bold**" });
      const { container } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[]} markdownEnabled={true} />
      );
      // User messages should always be plain text
      expect(container.textContent).toContain("**not bold**");
      expect(container.querySelector("strong")).toBeNull();
    });

    test("renders responseContent as markdown when markdownEnabled is true", () => {
      const log = createLogEntry({
        level: "agent",
        details: { logKind: "response", responseContent: "**bold response**" },
      });
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} markdownEnabled={true} />
      );
      const strong = container.querySelector("strong");
      expect(strong).not.toBeNull();
      expect(strong?.textContent).toBe("bold response");
    });

    test("uses regular body typography for markdown responses while keeping inline code monospace", () => {
      const log = createLogEntry({
        level: "agent",
        details: { logKind: "response", responseContent: "Normal text with `inlineCode()`." },
      });
      const { container, getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} markdownEnabled={true} />
      );
      const root = container.firstElementChild as HTMLElement;
      expect(root.className).not.toContain("font-mono");
      const inlineCode = container.querySelector("code");
      expect(inlineCode).not.toBeNull();
      expect(inlineCode?.className).toContain("font-mono");
      expect(getByText("Normal text with ", { exact: false })).toBeInTheDocument();
    });

    test("renders responseContent as plain text when markdownEnabled is false", () => {
      const log = createLogEntry({
        level: "agent",
        details: { logKind: "response", responseContent: "**bold response**" },
      });
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} markdownEnabled={false} />
      );
      expect(container.textContent).toContain("**bold response**");
      expect(container.querySelector("strong")).toBeNull();
    });

    test("uses regular body typography for raw response content when markdownEnabled is false", () => {
      const log = createLogEntry({
        level: "agent",
        details: { logKind: "response", responseContent: "Plain response content" },
      });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} markdownEnabled={false} />
      );
      const responseBlock = getByText("Plain response content");
      expect(responseBlock.className).not.toContain("font-mono");
    });

    test("renders markdown code blocks in responseContent logs", () => {
      const log = createLogEntry({
        level: "agent",
        details: { logKind: "response", responseContent: "Here is code:\n\n```js\nconsole.log('hello');\n```" },
      });
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} markdownEnabled={true} />
      );
      // Should render a <pre> element for the code block
      const pre = container.querySelector("pre");
      expect(pre).not.toBeNull();
      expect(pre?.textContent).toContain("console.log('hello');");
      expect(pre?.className).not.toContain("font-mono");
      const code = pre?.querySelector("code");
      expect(code).not.toBeNull();
    });

    test("renders markdown lists in responseContent logs", () => {
      const log = createLogEntry({
        level: "agent",
        details: { logKind: "response", responseContent: "Steps:\n\n- First item\n- Second item\n- Third item" },
      });
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} markdownEnabled={true} />
      );
      // Should render <li> elements
      const listItems = container.querySelectorAll("li");
      expect(listItems.length).toBe(3);
      expect(listItems[0]?.textContent).toBe("First item");
    });
  });

  describe("logKind filtering does not show logKind in Details", () => {
    test("logKind is not shown in the Details section", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI generating response...",
        details: { logKind: "response", responseContent: "content", extra: "value" },
      });
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      // The Details section should not contain logKind
      const preElements = container.querySelectorAll("pre");
      for (const pre of Array.from(preElements)) {
        expect(pre.textContent).not.toContain("logKind");
      }
    });
  });

  describe("working indicator (isActive)", () => {
    test("shows 'Working...' spinner when isActive=true and entries exist", () => {
      const msg = createMessageData({ role: "user", content: "Hello" });
      const { getByTestId, getByText } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[]} isActive={true} />
      );
      const indicator = getByTestId("working-indicator");
      expect(indicator).toBeInTheDocument();
      expect(getByText("Working...")).toBeInTheDocument();
    });

    test("shows 'Working...' spinner in empty state when isActive=true", () => {
      const { getByText, queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} isActive={true} />
      );
      expect(getByText("Working...")).toBeInTheDocument();
      expect(queryByText("No logs yet. Waiting for activity.")).not.toBeInTheDocument();
    });

    test("does not show spinner when isActive=false (default)", () => {
      const msg = createMessageData({ role: "user", content: "Hello" });
      const { queryByTestId } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[]} />
      );
      expect(queryByTestId("working-indicator")).not.toBeInTheDocument();
    });

    test("shows 'No logs yet' when isActive=false and no entries", () => {
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} isActive={false} />
      );
      expect(getByText("No logs yet. Waiting for activity.")).toBeInTheDocument();
    });

    test("shows spinner after all entries when isActive=true with mixed content", () => {
      const messages = [createMessageData({ content: "User msg", role: "user" })];
      const logs = [createLogEntry({
        level: "agent",
        message: "AI generating response...",
        details: { logKind: "response", responseContent: "Responding..." },
      })];

      const { getByTestId, getByText, queryByText } = renderWithUser(
        <LogViewer messages={messages} toolCalls={[]} logs={logs} isActive={true} />
      );

      expect(getByText("User msg")).toBeInTheDocument();
      expect(queryByText("AI generating response...")).not.toBeInTheDocument();
      expect(getByText("Responding...")).toBeInTheDocument();
      const indicator = getByTestId("working-indicator");
      expect(indicator).toBeInTheDocument();
    });

    test("spinner contains an animated spinner element", () => {
      const msg = createMessageData({ role: "user", content: "Hello" });
      const { getByTestId } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[]} isActive={true} />
      );
      const indicator = getByTestId("working-indicator");
      const spinner = indicator.querySelector(".animate-spin");
      expect(spinner).not.toBeNull();
    });
  });

  describe("action text deduplication", () => {
    test("consecutive same-group log entries hide action text for continuation entries", () => {
      const logs = [
        createLogEntry({
          id: "log-1",
          level: "agent",
          message: "AI generating response...",
          details: { logKind: "response", responseContent: "First response" },
          timestamp: "2026-01-01T00:00:01.000Z",
        }),
        createLogEntry({
          id: "log-2",
          level: "agent",
          message: "AI generating response...",
          details: { logKind: "response", responseContent: "Second response" },
          timestamp: "2026-01-01T00:00:02.000Z",
        }),
      ];
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={logs} />
      );

      // Both responseContent blocks should be visible
      expect(container.textContent).toContain("First response");
      expect(container.textContent).toContain("Second response");

      // Streaming response entries no longer render the redundant action text.
      const allText = container.textContent ?? "";
      const actionOccurrences = allText.split("AI generating response...").length - 1;
      expect(actionOccurrences).toBe(0);
    });

    test("first streaming response entry shows content without action text", () => {
      const logs = [
        createLogEntry({
          level: "agent",
          message: "AI generating response...",
          details: { logKind: "response", responseContent: "Some content" },
        }),
      ];
      const { getByText, queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={logs} />
      );

      expect(queryByText("AI generating response...")).not.toBeInTheDocument();
      expect(getByText("Some content")).toBeInTheDocument();
    });

    test("different streaming groups each show their content without action text", () => {
      const logs = [
        createLogEntry({
          id: "log-1",
          level: "agent",
          message: "AI generating response...",
          details: { logKind: "response", responseContent: "Response content" },
          timestamp: "2026-01-01T00:00:01.000Z",
        }),
        createLogEntry({
          id: "log-2",
          level: "agent",
          message: "AI reasoning...",
          details: { logKind: "reasoning", responseContent: "Reasoning content" },
          timestamp: "2026-01-01T00:00:02.000Z",
        }),
      ];
      const { getByText, queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={logs} />
      );

      expect(queryByText("AI generating response...")).not.toBeInTheDocument();
      expect(queryByText("AI reasoning...")).not.toBeInTheDocument();
      expect(getByText("Response content")).toBeInTheDocument();
      expect(getByText("Reasoning content")).toBeInTheDocument();
    });

    test("group broken by different entry type re-shows action text", () => {
      const logs = [
        createLogEntry({
          id: "log-1",
          level: "agent",
          message: "AI generating response...",
          details: { logKind: "response", responseContent: "First response" },
          timestamp: "2026-01-01T00:00:01.000Z",
        }),
        createLogEntry({
          id: "log-3",
          level: "agent",
          message: "AI generating response...",
          details: { logKind: "response", responseContent: "Third response" },
          timestamp: "2026-01-01T00:00:03.000Z",
        }),
      ];
      const messages = [
        createMessageData({
          role: "user",
          content: "User interruption",
          timestamp: "2026-01-01T00:00:02.000Z",
        }),
      ];
      const { container, getByText } = renderWithUser(
        <LogViewer messages={messages} toolCalls={[]} logs={logs} />
      );

      // The user message breaks the group, but streaming action text stays hidden.
      expect(getByText("User interruption")).toBeInTheDocument();
      expect(getByText("First response")).toBeInTheDocument();
      expect(getByText("Third response")).toBeInTheDocument();

      const allText = container.textContent ?? "";
      const actionOccurrences = allText.split("AI generating response...").length - 1;
      expect(actionOccurrences).toBe(0);
    });
  });
});
