/**
 * Tests for the LoopActionBar component.
 *
 * LoopActionBar provides stop/send controls and model changes for loops and chats.
 */

import { test, expect, describe, mock } from "bun:test";
import { LoopActionBar } from "@/components/LoopActionBar";
import { renderWithUser, waitFor } from "../helpers/render";
import { createModelInfo, createModelConfig } from "../helpers/factories";
import type { ModelInfo, ModelConfig } from "@/types";
import {
  createTestFile,
  installImageAttachmentMocks,
  pasteFiles,
} from "../helpers/image-paste";

installImageAttachmentMocks();

// Default props factory
function defaultProps(overrides?: Partial<Parameters<typeof LoopActionBar>[0]>) {
  return {
    models: [] as ModelInfo[],
    modelsLoading: false,
    onSubmit: mock(async () => true),
    onStop: undefined,
    ...overrides,
  };
}

describe("LoopActionBar", () => {
  describe("basic rendering", () => {
    test("renders the message input", () => {
      const { getByPlaceholderText } = renderWithUser(
        <LoopActionBar {...defaultProps()} />
      );
      expect(getByPlaceholderText("Send a message to steer the agent...")).toBeInTheDocument();
    });

    test("renders the Send button", () => {
      const { getByRole } = renderWithUser(
        <LoopActionBar {...defaultProps()} />
      );
      expect(getByRole("button", { name: "Send" })).toBeInTheDocument();
    });

    test("renders a model selector", () => {
      const { container } = renderWithUser(
        <LoopActionBar {...defaultProps()} />
      );
      const select = container.querySelector("select");
      expect(select).toBeInTheDocument();
    });

    test("renders the submit button with appropriate aria-label for planning mode", () => {
      const { getByRole } = renderWithUser(
        <LoopActionBar {...defaultProps({ isPlanning: true })} />
      );
      expect(getByRole("button", { name: "Send Feedback" })).toBeInTheDocument();
    });

    test("renders a Stop button while generation is active and stop is available", () => {
      const { getByRole } = renderWithUser(
        <LoopActionBar {...defaultProps({ isGenerating: true, onStop: mock(async () => true) })} />
      );
      expect(getByRole("button", { name: "Stop" })).toBeInTheDocument();
    });
  });

  describe("model selector", () => {
    test("shows 'Loading...' when models are loading", () => {
      const { container } = renderWithUser(
        <LoopActionBar {...defaultProps({ modelsLoading: true })} />
      );
      const select = container.querySelector("select") as HTMLSelectElement;
      expect(select).toBeDisabled();
      const loadingOption = Array.from(select.options).find(o => o.text === "Loading...");
      expect(loadingOption).toBeDefined();
    });

    test("shows current model name in default option", () => {
      const models = [
        createModelInfo({ providerID: "anthropic", modelID: "claude-sonnet-4-20250514", modelName: "Claude Sonnet 4", providerName: "Anthropic" }),
      ];
      const currentModel = createModelConfig({ providerID: "anthropic", modelID: "claude-sonnet-4-20250514" });

      const { container } = renderWithUser(
        <LoopActionBar {...defaultProps({ models, currentModel })} />
      );
      const select = container.querySelector("select") as HTMLSelectElement;
      const defaultOption = select.options[0];
      expect(defaultOption?.text).toBe("Claude Sonnet 4");
    });

    test("groups models by provider", () => {
      const models = [
        createModelInfo({ providerID: "anthropic", modelID: "claude-1", modelName: "Claude 1", providerName: "Anthropic", connected: true }),
        createModelInfo({ providerID: "openai", modelID: "gpt-4", modelName: "GPT-4", providerName: "OpenAI", connected: true }),
      ];

      const { container } = renderWithUser(
        <LoopActionBar {...defaultProps({ models })} />
      );
      const optgroups = container.querySelectorAll("optgroup");
      const labels = Array.from(optgroups).map(g => g.label);
      expect(labels).toContain("Anthropic");
      expect(labels).toContain("OpenAI");
    });

    test("shows disconnected providers with 'not connected' label", () => {
      const models = [
        createModelInfo({ providerID: "openai", modelID: "gpt-4", modelName: "GPT-4", providerName: "OpenAI", connected: false }),
      ];

      const { container } = renderWithUser(
        <LoopActionBar {...defaultProps({ models })} />
      );
      const optgroups = container.querySelectorAll("optgroup");
      const labels = Array.from(optgroups).map(g => g.label);
      expect(labels).toContain("OpenAI (not connected)");
    });

    test("marks the current model option as disabled and labeled (current)", () => {
      const models = [
        createModelInfo({ providerID: "anthropic", modelID: "claude-1", modelName: "Claude 1", providerName: "Anthropic", connected: true }),
      ];
      const currentModel = createModelConfig({ providerID: "anthropic", modelID: "claude-1" });

      const { container } = renderWithUser(
        <LoopActionBar {...defaultProps({ models, currentModel })} />
      );
      const options = container.querySelectorAll("option");
      const currentOption = Array.from(options).find(o => o.text.includes("(current)"));
      expect(currentOption).toBeDefined();
      expect(currentOption?.disabled).toBe(true);
    });

    test("renders model variants as separate options", () => {
      const models = [
        createModelInfo({
          providerID: "anthropic",
          modelID: "claude-sonnet",
          modelName: "Claude Sonnet",
          providerName: "Anthropic",
          connected: true,
          variants: ["fast", "precise"],
        }),
      ];

      const { container } = renderWithUser(
        <LoopActionBar {...defaultProps({ models })} />
      );
      const options = container.querySelectorAll("option");
      const optionTexts = Array.from(options).map(o => o.text);
      expect(optionTexts).toContain("Claude Sonnet (fast)");
      expect(optionTexts).toContain("Claude Sonnet (precise)");
    });
  });

  describe("disabled state", () => {
    test("disables all inputs when disabled=true", () => {
      const { getByPlaceholderText, getByRole, container } = renderWithUser(
        <LoopActionBar {...defaultProps({ disabled: true })} />
      );
      expect(getByPlaceholderText("Send a message to steer the agent...")).toBeDisabled();
      expect(getByRole("button", { name: "Send" })).toBeDisabled();
      expect(container.querySelector("select")).toBeDisabled();
    });

      test("disables the Stop button when disabled=true", () => {
        const { getByRole } = renderWithUser(
        <LoopActionBar {...defaultProps({ disabled: true, isGenerating: true, onStop: mock(async () => true) })} />
      );
      expect(getByRole("button", { name: "Stop" })).toBeDisabled();
    });
  });

  describe("form submission", () => {
    test("Send button is disabled when no changes", () => {
      const { getByRole } = renderWithUser(
        <LoopActionBar {...defaultProps()} />
      );
      expect(getByRole("button", { name: "Send" })).toBeDisabled();
    });

    test("Send button is enabled when message is entered", async () => {
      const { getByPlaceholderText, getByRole, user } = renderWithUser(
        <LoopActionBar {...defaultProps()} />
      );
      await user.type(getByPlaceholderText("Send a message to steer the agent..."), "Test message");
      expect(getByRole("button", { name: "Send" })).not.toBeDisabled();
    });

    test("calls onStop when the Stop button is clicked during generation", async () => {
      const onStop = mock(async () => true);
      const { getByRole, user } = renderWithUser(
        <LoopActionBar {...defaultProps({ isGenerating: true, onStop })} />
      );

      await user.click(getByRole("button", { name: "Stop" }));

      await waitFor(() => {
        expect(onStop).toHaveBeenCalledTimes(1);
      });
    });

    test("keeps the Stop button visible while generating even if text is entered", async () => {
      const onStop = mock(async () => true);
      const onSubmit = mock(async (_data: { message?: string; model?: ModelConfig }) => true);
      const { getByPlaceholderText, getByRole, queryByRole, user } = renderWithUser(
        <LoopActionBar {...defaultProps({ isGenerating: true, onStop, onSubmit })} />
      );

      await user.type(getByPlaceholderText("Send a message to steer the agent..."), "Hello agent");

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
        <LoopActionBar {...defaultProps({ models, isGenerating: true, onStop: mock(async () => true), onSubmit })} />
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
        <LoopActionBar
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
      const { getByPlaceholderText, getByRole, user } = renderWithUser(
        <LoopActionBar {...defaultProps({ onSubmit })} />
      );

      await user.type(getByPlaceholderText("Send a message to steer the agent..."), "Hello agent");
      await user.click(getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
      const callArgs = onSubmit.mock.calls[0]![0];
      expect(callArgs.message).toBe("Hello agent");
    });

    test("calls onSubmit with model when model is changed", async () => {
      const onSubmit = mock(async (_data: { message?: string; model?: ModelConfig }) => true);
      const models = [
        createModelInfo({ providerID: "anthropic", modelID: "claude-1", modelName: "Claude 1", providerName: "Anthropic", connected: true }),
        createModelInfo({ providerID: "openai", modelID: "gpt-4", modelName: "GPT-4", providerName: "OpenAI", connected: true }),
      ];

      const { container, getByRole, user } = renderWithUser(
        <LoopActionBar {...defaultProps({ models, onSubmit })} />
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
      const { getByPlaceholderText, getByRole, getByText, user } = renderWithUser(
        <LoopActionBar {...defaultProps({ onSubmit })} />
      );

      const input = getByPlaceholderText("Send a message to steer the agent...");
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

    test("clears message input after successful submission", async () => {
      const onSubmit = mock(async () => true);
      const { getByPlaceholderText, getByRole, user } = renderWithUser(
        <LoopActionBar {...defaultProps({ onSubmit })} />
      );

      const input = getByPlaceholderText("Send a message to steer the agent...");
      await user.type(input, "Test");
      await user.click(getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect((input as HTMLInputElement).value).toBe("");
      });
    });

    test("does not clear message on failed submission", async () => {
      const onSubmit = mock(async () => false);
      const { getByPlaceholderText, getByRole, user } = renderWithUser(
        <LoopActionBar {...defaultProps({ onSubmit })} />
      );

      const input = getByPlaceholderText("Send a message to steer the agent...");
      await user.type(input, "Test");
      await user.click(getByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
      expect((input as HTMLInputElement).value).toBe("Test");
    });
  });

  describe("disconnected model error", () => {
    test("shows error when disconnected model is selected", async () => {
      // Include both a connected and disconnected model. The disconnected option
      // is disabled in the DOM, so we set the select value directly via fireEvent.
      const models = [
        createModelInfo({ providerID: "anthropic", modelID: "claude-1", modelName: "Claude 1", providerName: "Anthropic", connected: true }),
        createModelInfo({ providerID: "openai", modelID: "gpt-4", modelName: "GPT-4", providerName: "OpenAI", connected: false }),
      ];

      const { container, getByText } = renderWithUser(
        <LoopActionBar {...defaultProps({ models })} />
      );

      // Manually set the select value to a disconnected model (since user-event can't select disabled options)
      const select = container.querySelector("select") as HTMLSelectElement;
      // Simulate change
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, "openai:gpt-4:");
      select.dispatchEvent(new Event("change", { bubbles: true }));

      await waitFor(() => {
        expect(getByText(/The selected model's provider is not connected/)).toBeInTheDocument();
      });
    });

    test("Send button is disabled when disconnected model is selected with a message", async () => {
      const models = [
        createModelInfo({ providerID: "anthropic", modelID: "claude-1", modelName: "Claude 1", providerName: "Anthropic", connected: true }),
        createModelInfo({ providerID: "openai", modelID: "gpt-4", modelName: "GPT-4", providerName: "OpenAI", connected: false }),
      ];

      const { container, getByRole, user, getByPlaceholderText } = renderWithUser(
        <LoopActionBar {...defaultProps({ models })} />
      );

      // Set disconnected model via direct DOM manipulation
      const select = container.querySelector("select") as HTMLSelectElement;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, "openai:gpt-4:");
      select.dispatchEvent(new Event("change", { bubbles: true }));

      // Also type a message so hasLocalChanges is true
      await user.type(getByPlaceholderText("Send a message to steer the agent..."), "hello");

      expect(getByRole("button", { name: "Send" })).toBeDisabled();
    });
  });

  describe("generation state", () => {
    test("shows Stop instead of Send while generating", () => {
      const { getByRole, queryByRole } = renderWithUser(
        <LoopActionBar {...defaultProps({ isGenerating: true, onStop: mock(async () => true) })} />
      );

      expect(getByRole("button", { name: "Stop" })).toBeInTheDocument();
      expect(queryByRole("button", { name: "Send" })).toBeNull();
    });
  });

  describe("terminal follow-up copy", () => {
    test("renders custom submit label as aria-label", () => {
      const { getByRole } = renderWithUser(
        <LoopActionBar
          {...defaultProps({
            submitLabel: "Restart",
          })}
        />,
      );

      expect(getByRole("button", { name: "Restart" })).toBeInTheDocument();
    });
  });
});
