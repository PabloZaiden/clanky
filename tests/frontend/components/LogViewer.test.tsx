/**
 * Tests for the LogViewer component.
 *
 * LogViewer displays messages, tool calls, and application logs
 * in chronological order with auto-scroll behavior.
 */

import { test, expect, describe } from "bun:test";
import { LogViewer } from "@/components/LogViewer";
import type { LogEntry } from "@/components/LogViewer";
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

    test("uses vertical scrolling while hiding panel-level horizontal overflow", () => {
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[]} />
      );
      const root = container.firstElementChild as HTMLElement;
      expect(root.className).toContain("min-w-0");
      expect(root.className).toContain("overflow-x-hidden");
      expect(root.className).toContain("overflow-y-auto");
    });
  });

  describe("message rendering", () => {
    test("renders a user message", () => {
      const msg = createMessageData({ role: "user", content: "Hello world" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[msg]} toolCalls={[]} />
      );
      expect(getByText("Hello world")).toBeInTheDocument();
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
  });

  describe("tool call rendering", () => {
    test("renders a completed tool call with check mark", () => {
      const tool = createToolCallData({ name: "Write", status: "completed" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={true} />
      );
      expect(getByText("Write")).toBeInTheDocument();
      expect(getByText("✓")).toBeInTheDocument();
    });

    test("renders a failed tool call with X mark", () => {
      const tool = createToolCallData({ name: "Read", status: "failed" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={true} />
      );
      expect(getByText("Read")).toBeInTheDocument();
      expect(getByText("✗")).toBeInTheDocument();
    });

    test("renders a pending tool call with circle", () => {
      const tool = createToolCallData({ name: "Bash", status: "pending" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={true} />
      );
      expect(getByText("Bash")).toBeInTheDocument();
      expect(getByText("○")).toBeInTheDocument();
    });

    test("renders a running tool call with spinner", () => {
      const tool = createToolCallData({ name: "Glob", status: "running" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={true} />
      );
      expect(getByText("Glob")).toBeInTheDocument();
      expect(getByText("⟳")).toBeInTheDocument();
    });

    test("renders tool input in collapsible details", async () => {
      const tool = createToolCallData({
        name: "Write",
        input: { filePath: "/src/test.ts", content: "hello" },
      });
      const { container, getByText, user } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={true} />
      );
      // Input should be in a details/summary element
      const inputSummary = getByText("Input");
      expect(inputSummary).toBeInTheDocument();
      expect(container.querySelectorAll("pre")).toHaveLength(0);
      // Clicking the summary should open details (toggle handled by browser)
      await user.click(inputSummary);
      const inputPre = Array.from(container.querySelectorAll("pre")).find(
        (element) => element.textContent?.includes("\"filePath\": \"/src/test.ts\"")
      );
      expect(inputPre).toBeDefined();
    });

    test("renders tool output in collapsible details", async () => {
      const tool = createToolCallData({
        name: "Read",
        output: "file contents here",
      });
      const { getByText, queryByText, user } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={true} />
      );
      expect(getByText("Output")).toBeInTheDocument();
      expect(queryByText("file contents here")).not.toBeInTheDocument();
      await user.click(getByText("Output"));
      expect(getByText("file contents here")).toBeInTheDocument();
    });

    test("keeps tool detail content mounted after first expansion", async () => {
      const tool = createToolCallData({
        name: "Read",
        output: "file contents here",
      });
      const { getByText, queryByText, user } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={true} />
      );
      const outputSummary = getByText("Output");
      expect(queryByText("file contents here")).not.toBeInTheDocument();
      await user.click(outputSummary);
      expect(getByText("file contents here")).toBeInTheDocument();
      await user.click(outputSummary);
      expect(queryByText("file contents here")).toBeInTheDocument();
    });

    test("renders tool output as JSON when it is an object", async () => {
      const tool = createToolCallData({
        name: "Bash",
        output: { exitCode: 0, stdout: "ok" },
      });
      const { container, getByText, user } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={true} />
      );
      expect(container.querySelectorAll("pre")).toHaveLength(0);
      await user.click(getByText("Output"));
      // JSON stringified output should be in the pre element
      const preElements = container.querySelectorAll("pre");
      const outputPre = Array.from(preElements).find(
        (el) => el.textContent?.includes('"exitCode"')
      );
      expect(outputPre).toBeDefined();
    });

    test("does not render Input details when input is null", () => {
      const tool = createToolCallData({ name: "Write", input: null });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={true} />
      );
      expect(queryByText("Input")).not.toBeInTheDocument();
    });

    test("does not render Output details when output is null", () => {
      const tool = createToolCallData({ name: "Write", output: undefined });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={true} />
      );
      expect(queryByText("Output")).not.toBeInTheDocument();
    });

    test("hides tool calls when showTools is false (default)", () => {
      const tool = createToolCallData({ name: "Write", status: "completed" });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} />
      );
      expect(queryByText("Write")).not.toBeInTheDocument();
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

    test("renders log details in collapsible section", async () => {
      const log = createLogEntry({
        level: "agent",
        details: { key: "value", count: 42 },
      });
      const { container, getByText, user } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} />
      );
      expect(getByText("Details")).toBeInTheDocument();
      expect(container.querySelectorAll("pre")).toHaveLength(0);
      await user.click(getByText("Details"));
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
    test("renders reasoning entries with italic and dimmed styling", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI reasoning...",
        details: { logKind: "reasoning", responseContent: "thinking" },
      });
      const { container } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showReasoning={true} />
      );
      const group = container.querySelector(".group");
      expect(group).not.toBeNull();
      // Should have opacity-60 on the group
      expect(group?.className).toContain("opacity-60");
      // The text container should have italic class
      const textDiv = group?.querySelector(".italic");
      expect(textDiv).not.toBeNull();
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
      const group = container.querySelector(".group");
      expect(group).not.toBeNull();
      // Should NOT have opacity-60
      expect(group?.className).not.toContain("opacity-60");
    });
  });

  describe("tools filtering", () => {
    test("hides tool call entries by default (showTools=false)", () => {
      const tool = createToolCallData({ name: "Write", status: "completed" });
      const { queryByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} />
      );
      expect(queryByText("Write")).not.toBeInTheDocument();
    });

    test("shows tool call entries when showTools=true", () => {
      const tool = createToolCallData({ name: "Write", status: "completed" });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[tool]} showTools={true} />
      );
      expect(getByText("Write")).toBeInTheDocument();
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

    test("shows tool-related agent logs when showTools=true", () => {
      const log = createLogEntry({
        level: "agent",
        message: "AI calling tool: Write",
        details: { logKind: "tool" },
      });
      const { getByText } = renderWithUser(
        <LogViewer messages={[]} toolCalls={[]} logs={[log]} showTools={true} />
      );
      expect(getByText("AI calling tool: Write")).toBeInTheDocument();
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

      // Verify order: FirstTool (01), Second entry (02), Third entry (03)
      expect(groups[0]?.textContent).toContain("FirstTool");
      expect(groups[1]?.textContent).toContain("Second entry");
      expect(groups[2]?.textContent).toContain("Third entry");
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
      const toolCalls = [createToolCallData({ name: "Edit", status: "completed" })];
      const logs = [createLogEntry({ level: "info", message: "Processing complete" })];

      const { getByText } = renderWithUser(
        <LogViewer messages={messages} toolCalls={toolCalls} logs={logs} showTools={true} showSystemInfo={true} />
      );

      expect(getByText("Hello from user")).toBeInTheDocument();
      expect(getByText("Edit")).toBeInTheDocument();
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
