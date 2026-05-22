/**
 * Tests for the TaskActionBar component.
 *
 * TaskActionBar provides stop/send controls and model changes for tasks.
 */

import { test, expect, describe, mock } from "bun:test";
import { TaskActionBar } from "@/components/TaskActionBar";
import { renderWithUser, waitFor } from "../helpers/render";
import { createModelInfo } from "../helpers/factories";
import type { ModelInfo, ModelConfig } from "@/types";
import {
  createTestFile,
  installImageAttachmentMocks,
  pasteFiles,
} from "../helpers/image-paste";
import { mockComposerSoftWrap } from "../helpers/composer-measurement";

const imageAttachmentMocks = installImageAttachmentMocks();

// Default props factory
function defaultProps(overrides?: Partial<Parameters<typeof TaskActionBar>[0]>) {
  return {
    models: [] as ModelInfo[],
    modelsLoading: false,
    onSubmit: mock(async () => true),
    onStop: undefined,
    ...overrides,
  };
}

function getTaskMessageInput(getByRole: (role: string, options?: Record<string, unknown>) => HTMLElement) {
  return getByRole("textbox", { name: "Task message" }) as HTMLTextAreaElement;
}

function getPlanFeedbackInput(getByRole: (role: string, options?: Record<string, unknown>) => HTMLElement) {
  return getByRole("textbox", { name: "Plan feedback" }) as HTMLTextAreaElement;
}

describe("TaskActionBar", () => {
  describe("disabled state", () => {
    test("disables all inputs when disabled=true", () => {
      const { getByRole, container } = renderWithUser(
        <TaskActionBar {...defaultProps({ disabled: true })} />
      );
      expect(getTaskMessageInput(getByRole)).toBeDisabled();
      expect(getByRole("button", { name: "Send" })).toBeDisabled();
      expect(container.querySelector("select")).toBeDisabled();
    });

      test("disables the Stop button when disabled=true", () => {
        const { getByRole } = renderWithUser(
        <TaskActionBar {...defaultProps({ disabled: true, isGenerating: true, onStop: mock(async () => true) })} />
      );
      expect(getByRole("button", { name: "Stop" })).toBeDisabled();
    });
  });

  describe("form submission", () => {
    test("Send button is disabled when no changes", () => {
      const { getByRole } = renderWithUser(
        <TaskActionBar {...defaultProps()} />
      );
      expect(getByRole("button", { name: "Send" })).toBeDisabled();
    });

    test("Send button is enabled when message is entered", async () => {
      const { getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps()} />
      );
      await user.type(getTaskMessageInput(getByRole), "Test message");
      expect(getByRole("button", { name: "Send" })).not.toBeDisabled();
    });

    test("calls onStop when the Stop button is clicked during generation", async () => {
      const onStop = mock(async () => true);
      const { getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ isGenerating: true, onStop })} />
      );

      await user.click(getByRole("button", { name: "Stop" }));

      await waitFor(() => {
        expect(onStop).toHaveBeenCalledTimes(1);
      });
    });

    test("prevents the send button from taking focus on press", async () => {
      const { getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps()} />
      );

      await user.type(getTaskMessageInput(getByRole), "Steer the task");

      const sendButton = getByRole("button", { name: "Send" });
      const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });

      expect(sendButton.dispatchEvent(mouseDown)).toBe(false);
      expect(mouseDown.defaultPrevented).toBe(true);
    });

    test("prevents the plan feedback send button from taking focus on press", async () => {
      const { getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ isPlanning: true })} />
      );

      await user.type(getPlanFeedbackInput(getByRole), "Refine the implementation plan");

      const sendButton = getByRole("button", { name: "Send Feedback" });
      const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });

      expect(sendButton.dispatchEvent(mouseDown)).toBe(false);
      expect(mouseDown.defaultPrevented).toBe(true);
    });

    test("keeps the Stop button visible while generating even if text is entered", async () => {
      const onStop = mock(async () => true);
      const onSubmit = mock(async (_data: { message?: string; model?: ModelConfig }) => true);
      const { getByRole, queryByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ isGenerating: true, onStop, onSubmit })} />
      );

      await user.type(getTaskMessageInput(getByRole), "Hello agent");

      expect(queryByRole("button", { name: "Send" })).toBeNull();
      await user.click(getByRole("button", { name: "Stop" }));

      await waitFor(() => {
        expect(onStop).toHaveBeenCalledTimes(1);
      });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    test("keeps the Stop button visible for model-only edits while generating", async () => {
      const onSubmit = mock(async (_data: { message?: string; model?: ModelConfig }) => true);
      const models = [
        createModelInfo({ providerID: "openai", modelID: "gpt-4", modelName: "GPT-4", providerName: "OpenAI", connected: true }),
      ];
      const { container, getByRole, queryByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ models, isGenerating: true, onStop: mock(async () => true), onSubmit })} />
      );

      const select = container.querySelector("select") as HTMLSelectElement;
      await user.selectOptions(select, "openai:gpt-4:");

      expect(queryByRole("button", { name: "Send" })).toBeNull();
      await user.click(getByRole("button", { name: "Stop" }));

      await waitFor(() => {
        expect(onSubmit).not.toHaveBeenCalled();
      });
    });

    test("requires a message for terminal follow-up submissions", async () => {
      const models = [
        createModelInfo({ providerID: "openai", modelID: "gpt-4", modelName: "GPT-4", providerName: "OpenAI", connected: true }),
      ];
      const { container, getByRole, user } = renderWithUser(
        <TaskActionBar
          {...defaultProps({
            models,
            requireMessage: true,
            submitLabel: "Restart",
          })}
        />,
      );

      const select = container.querySelector("select") as HTMLSelectElement;
      await user.selectOptions(select, "openai:gpt-4:");

      expect(getByRole("button", { name: "Restart" })).toBeDisabled();
    });

    test("calls onSubmit with message when submitted", async () => {
      const onSubmit = mock(async (_data: { message?: string; model?: ModelConfig }) => true);
      const { getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ onSubmit })} />
      );

      await user.type(getTaskMessageInput(getByRole), "Hello agent");
      await user.click(getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
      const callArgs = onSubmit.mock.calls[0]![0];
      expect(callArgs.message).toBe("Hello agent");
    });

    test("inserts a newline instead of submitting on plain Enter", async () => {
      const onSubmit = mock(async (_data: { message?: string; model?: ModelConfig }) => true);
      const { getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ onSubmit })} />
      );

      const composer = getTaskMessageInput(getByRole);
      await user.type(composer, "First line{enter}Second line");

      expect(composer.value).toBe("First line\nSecond line");
      expect(composer.getAttribute("rows")).toBe("2");
      expect(onSubmit).not.toHaveBeenCalled();
    });

    test("switches to multiline sizing when content soft-wraps without an explicit newline", async () => {
      const { getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps()} />
      );

      const composer = getTaskMessageInput(getByRole);
      mockComposerSoftWrap(composer, (value) => value.length >= 24);

      await user.type(composer, "This message softly wraps");

      await waitFor(() => {
        expect(composer.getAttribute("rows")).toBe("2");
      });
      expect(composer.value.includes("\n")).toBe(false);
    });

    test("submits with Ctrl+Enter", async () => {
      const onSubmit = mock(async (_data: { message?: string; model?: ModelConfig }) => true);
      const { getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ onSubmit })} />
      );

      await user.type(getTaskMessageInput(getByRole), "Hello agent");
      await user.keyboard("{Control>}{Enter}{/Control}");

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
      expect(onSubmit.mock.calls[0]![0]).toEqual(
        expect.objectContaining({
          message: "Hello agent",
        }),
      );
    });

    test("calls onSubmit with model when model is changed", async () => {
      const onSubmit = mock(async (_data: { message?: string; model?: ModelConfig }) => true);
      const models = [
        createModelInfo({ providerID: "anthropic", modelID: "claude-1", modelName: "Claude 1", providerName: "Anthropic", connected: true }),
        createModelInfo({ providerID: "openai", modelID: "gpt-4", modelName: "GPT-4", providerName: "OpenAI", connected: true }),
      ];

      const { container, getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ models, onSubmit })} />
      );

      const select = container.querySelector("select") as HTMLSelectElement;
      await user.selectOptions(select, "openai:gpt-4:");
      await user.click(getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
      const callArgs = onSubmit.mock.calls[0]![0];
      expect(callArgs.model).toEqual({ providerID: "openai", modelID: "gpt-4", variant: "" });
    });

    test("calls onSubmit with pasted image attachments", async () => {
      const onSubmit = mock(async (_data: { message?: string; attachments?: unknown[] }) => true);
      const { getByRole, getByText, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ onSubmit })} />
      );

      const input = getTaskMessageInput(getByRole);
      await user.type(input, "Please inspect this");
      pasteFiles(input, [createTestFile({ name: "queued-image.png" })]);

      await waitFor(() => {
        expect(getByText("queued-image.png")).toBeInTheDocument();
      });

      await user.click(getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      expect(onSubmit.mock.calls[0]![0]).toEqual(
        expect.objectContaining({
          message: "Please inspect this",
          attachments: expect.arrayContaining([
            expect.objectContaining({
              filename: "queued-image.png",
              mimeType: "image/png",
            }),
          ]),
        }),
      );
    });

    test("clears stale attachment errors after a successful send", async () => {
      const onSubmit = mock(async () => true);
      const { getByRole, queryByText, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ onSubmit })} />
      );

      const input = getTaskMessageInput(getByRole);
      pasteFiles(input, [createTestFile({ name: "clipboard-image.svg", type: "image/svg+xml" })]);

      await waitFor(() => {
        expect(queryByText(/clipboard-image\.svg is not a supported image type/i)).toBeInTheDocument();
      });

      await user.type(input, "Please inspect this");
      await user.click(getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(queryByText(/clipboard-image\.svg is not a supported image type/i)).not.toBeInTheDocument();
      });
    });

    test("revokes removed task attachment previews once through shared cleanup", async () => {
      const { getByRole, queryByText, user } = renderWithUser(
        <TaskActionBar {...defaultProps()} />
      );

      const input = getTaskMessageInput(getByRole);
      pasteFiles(input, [createTestFile({ name: "task-image.png" })]);

      await waitFor(() => {
        expect(queryByText("task-image.png")).toBeInTheDocument();
      });

      expect(imageAttachmentMocks.revokeObjectURL).toHaveBeenCalledTimes(0);

      await user.click(getByRole("button", { name: "Remove task-image.png" }));

      await waitFor(() => {
        expect(queryByText("task-image.png")).not.toBeInTheDocument();
      });

      expect(imageAttachmentMocks.revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(imageAttachmentMocks.revokeObjectURL).toHaveBeenLastCalledWith("blob:mock:task-image.png");
    });

    test("clears message input after successful submission", async () => {
      const onSubmit = mock(async () => true);
      const { getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ onSubmit })} />
      );

      const input = getTaskMessageInput(getByRole);
      await user.type(input, "Test");
      await user.click(getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect((input as HTMLTextAreaElement).value).toBe("");
      });
    });

    test("does not clear message on failed submission", async () => {
      const onSubmit = mock(async () => false);
      const { getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ onSubmit })} />
      );

      const input = getTaskMessageInput(getByRole);
      await user.type(input, "Test");
      await user.click(getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
      expect((input as HTMLTextAreaElement).value).toBe("Test");
    });
  });

  describe("disconnected model error", () => {
    test("Send button is disabled when disconnected model is selected with a message", async () => {
      const models = [
        createModelInfo({ providerID: "anthropic", modelID: "claude-1", modelName: "Claude 1", providerName: "Anthropic", connected: true }),
        createModelInfo({ providerID: "openai", modelID: "gpt-4", modelName: "GPT-4", providerName: "OpenAI", connected: false }),
      ];

      const { container, getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ models })} />
      );

      // Set disconnected model via direct DOM manipulation
      const select = container.querySelector("select") as HTMLSelectElement;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, "openai:gpt-4:");
      select.dispatchEvent(new Event("change", { bubbles: true }));

      // Also type a message so hasLocalChanges is true
      await user.type(getTaskMessageInput(getByRole), "hello");

      expect(getByRole("button", { name: "Send" })).toBeDisabled();
    });
  });

  describe("generation state", () => {
    test("shows Stop instead of Send while generating", () => {
      const { getByRole, queryByRole } = renderWithUser(
        <TaskActionBar {...defaultProps({ isGenerating: true, onStop: mock(async () => true) })} />
      );

      expect(getByRole("button", { name: "Stop" })).toBeInTheDocument();
      expect(queryByRole("button", { name: "Send" })).toBeNull();
    });

    test("does not submit when Enter is pressed while generating", async () => {
      const onStop = mock(async () => true);
      const onSubmit = mock(async (_data: { message?: string; model?: ModelConfig }) => true);
      const { getByRole, user } = renderWithUser(
        <TaskActionBar {...defaultProps({ isGenerating: true, onStop, onSubmit })} />
      );

      await user.type(getTaskMessageInput(getByRole), "Hello agent{enter}");

      expect(onSubmit).not.toHaveBeenCalled();
      expect(onStop).not.toHaveBeenCalled();
    });
  });

});
