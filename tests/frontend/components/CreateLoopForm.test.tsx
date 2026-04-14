/**
 * Tests for the CreateLoopForm component.
 *
 * CreateLoopForm is a complex form for creating new Ralph Loops,
 * including workspace/model/branch selection, plan mode toggle,
 * advanced options, and draft saving.
 */

import { test, expect, describe, mock } from "bun:test";
import { CreateLoopForm, type CreateLoopFormActionState, type CreateLoopFormSubmitRequest } from "@/components/CreateLoopForm";
import { renderWithUser, waitFor, act } from "../helpers/render";
import {
  createModelInfo,
  createBranchInfo,
  createWorkspace,
} from "../helpers/factories";
import type { ModelInfo, CreateLoopRequest } from "@/types";
import type { Workspace } from "@/types/workspace";
import { DEFAULT_LOOP_CONFIG } from "@/types/loop";
import { PROMPT_TEMPLATES, getTemplateById } from "@/lib/prompt-templates";
import {
  createTestFile,
  installImageAttachmentMocks,
  pasteFiles,
} from "../helpers/image-paste";

installImageAttachmentMocks();

/**
 * Helper to set a textarea/input value for form testing.
 * user.type() causes OOM on complex forms even with short strings (4+ chars) due to
 * cascading useEffect re-renders on each keystroke. This helper types a single
 * character with user.type() to properly trigger React's onChange, which is enough
 * to make the form valid for testing submission flows.
 */
async function setInputValue(
  user: ReturnType<typeof import("@testing-library/user-event")["default"]["setup"]>,
  element: HTMLTextAreaElement | HTMLInputElement,
  value: string,
) {
  await user.clear(element);
  await user.type(element, value);
}

// Default props factory
function defaultProps(overrides?: Partial<Parameters<typeof CreateLoopForm>[0]>) {
  return {
    onSubmit: mock(async (_req: CreateLoopFormSubmitRequest) => true),
    onCancel: mock(() => {}),
    ...overrides,
  };
}

// Common test data
function connectedModels(): ModelInfo[] {
  return [
    createModelInfo({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-20250514",
      modelName: "Claude Sonnet 4",
      providerName: "Anthropic",
      connected: true,
    }),
    createModelInfo({
      providerID: "openai",
      modelID: "gpt-4o",
      modelName: "GPT-4o",
      providerName: "OpenAI",
      connected: true,
    }),
  ];
}

function testWorkspaces(): Workspace[] {
  return [
    createWorkspace({
      id: "ws-1",
      name: "Project A",
      directory: "/workspaces/project-a",
    }),
    createWorkspace({
      id: "ws-2",
      name: "Project B",
      directory: "/workspaces/project-b",
    }),
  ];
}

describe("CreateLoopForm", () => {
  describe("basic rendering", () => {
    test("renders workspace selector", () => {
      const { getByText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ workspaces: testWorkspaces() })} />
      );
      expect(getByText("Workspace")).toBeInTheDocument();
    });

    test("shows only workspace names in the loop creation dropdown", () => {
      const workspaces = [
        createWorkspace({
          id: "ws-1",
          name: "Project A",
          directory: "/workspaces/project-a",
          serverSettings: {
            agent: {
              provider: "opencode",
              transport: "ssh",
              hostname: "remote.example",
              port: 2222,
            },
          },
        }),
      ];
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ workspaces })} />
      );
      const select = getByLabelText("Workspace *") as HTMLSelectElement;
      const workspaceOption = Array.from(select.options).find(
        (option) => option.value === "ws-1"
      );

      expect(workspaceOption).toBeDefined();
      expect(workspaceOption?.text).toBe("Project A");
    });

    test("renders base branch selector", () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      expect(getByLabelText("Base Branch")).toBeInTheDocument();
    });

    test("renders model selector", () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      expect(getByLabelText("Model")).toBeInTheDocument();
    });

    test("renders prompt textarea", () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      expect(getByLabelText(/Prompt/)).toBeInTheDocument();
    });

    test("renders title input", () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      const input = getByLabelText(/Title/) as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input.maxLength).toBe(100);
    });

    test("renders title character counter", async () => {
      const { getByLabelText, getByText, user } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      expect(getByText("0/100 characters")).toBeInTheDocument();
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Loop title");
      await waitFor(() => {
        expect(getByText("10/100 characters")).toBeInTheDocument();
      });
    });

    test("renders plan mode checkbox checked by default", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      const checkbox = getByRole("checkbox", { name: /Plan Mode/ }) as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    });

    test("renders use worktree checkbox checked by default", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      const checkbox = getByRole("checkbox", { name: /Use Worktree/ }) as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    });

    test("renders advanced options toggle", () => {
      const { getByText } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      expect(getByText("Show advanced options")).toBeInTheDocument();
    });

    test("renders action buttons when renderActions is not provided", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      expect(getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(getByRole("button", { name: "Create" })).toBeInTheDocument();
    });

    test("does not render action buttons when renderActions is provided", () => {
      const { queryByRole } = renderWithUser(
        <CreateLoopForm {...defaultProps({ renderActions: mock(() => {}) })} />
      );
      expect(queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      expect(queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
    });
  });

  describe("model selector", () => {
    test("shows 'Loading models...' when modelsLoading is true", () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ modelsLoading: true })} />
      );
      const select = getByLabelText("Model") as HTMLSelectElement;
      expect(select).toBeDisabled();
      const options = Array.from(select.options).map(o => o.text);
      expect(options).toContain("Loading models...");
    });

    test("shows 'Select a workspace to load models' when no models", () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ models: [] })} />
      );
      const select = getByLabelText("Model") as HTMLSelectElement;
      const options = Array.from(select.options).map(o => o.text);
      expect(options).toContain("Select a workspace to load models");
    });

    test("groups models by provider", () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ models: connectedModels() })} />
      );
      const select = getByLabelText("Model") as HTMLSelectElement;
      const optgroups = select.querySelectorAll("optgroup");
      const labels = Array.from(optgroups).map(g => g.label);
      expect(labels).toContain("Anthropic");
      expect(labels).toContain("OpenAI");
    });

    test("auto-selects first connected model", async () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ models: connectedModels() })} />
      );
      const select = getByLabelText("Model") as HTMLSelectElement;
      // Should auto-select first connected model (Anthropic - sorted alphabetically)
      await waitFor(() => {
        expect(select.value).toBe("anthropic:claude-sonnet-4-20250514:");
      });
    });

    test("auto-selects lastModel when provided", async () => {
      const models = connectedModels();
      const lastModel = { providerID: "openai", modelID: "gpt-4o" };

      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ models, lastModel })} />
      );
      const select = getByLabelText("Model") as HTMLSelectElement;
      await waitFor(() => {
        expect(select.value).toBe("openai:gpt-4o:");
      });
    });

    test("shows error when no providers are connected", () => {
      const models = [
        createModelInfo({ connected: false, providerName: "Anthropic" }),
      ];
      const { getByText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ models })} />
      );
      expect(getByText(/No providers are connected/)).toBeInTheDocument();
    });

    test("shows required model error when models available but none selected", async () => {
      // Render with models but no lastModel - component will auto-select first connected
      // We need to prevent auto-selection, so render with models that are all disconnected 
      // but at least one provider exists
      const models = connectedModels();
      // Use a fresh render where we manually clear the selection after auto-select
      const { getByLabelText, getByText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ models })} />
      );
      
      const select = getByLabelText("Model") as HTMLSelectElement;
      
      // Wait for auto-selection, then clear it using DOM manipulation
      await waitFor(() => {
        expect(select.value).not.toBe("");
      });
      
      // Use direct DOM manipulation to clear the selection (same pattern as LoopActionBar tests)
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, "");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      
      await waitFor(() => {
        expect(getByText("Model is required. Please select a model.")).toBeInTheDocument();
      });
    });

    test("disables title generation until a valid model is selected", async () => {
      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            workspaces: testWorkspaces(),
            models: [],
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *"), "ws-1");
      await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");

      expect(getByRole("button", { name: "Generate title with AI" })).toBeDisabled();
    });

    test("renders model variants as separate options", () => {
      const models = [
        createModelInfo({
          providerID: "anthropic",
          modelID: "claude-sonnet",
          modelName: "Claude Sonnet",
          providerName: "Anthropic",
          connected: true,
          variants: ["fast", "standard"],
        }),
      ];

      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ models })} />
      );
      const select = getByLabelText("Model") as HTMLSelectElement;
      const optionTexts = Array.from(select.options).map(o => o.text);
      expect(optionTexts).toContain("Claude Sonnet (fast)");
      expect(optionTexts).toContain("Claude Sonnet (standard)");
    });

    test("defaults the cheap helper model to same-as-loop", async () => {
      const { getByLabelText, getByText, user } = renderWithUser(
        <CreateLoopForm {...defaultProps({ models: connectedModels() })} />
      );

      await user.click(getByText("Show advanced options"));

      const select = getByLabelText("Cheap helper model") as HTMLSelectElement;
      await waitFor(() => {
        expect(select.value).toBe("__same_as_loop_model__");
      });

      const optionTexts = Array.from(select.options).map((option) => option.text);
      expect(optionTexts).toContain("Same as loop model");
    });

    test("falls back to same-as-loop when the remembered cheap model is unavailable", async () => {
      const { getByLabelText, getByText, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            models: connectedModels(),
            lastCheapModel: {
              mode: "custom",
              model: {
                providerID: "missing-provider",
                modelID: "missing-model",
                variant: "",
              },
            },
          })}
        />
      );

      await user.click(getByText("Show advanced options"));

      const select = getByLabelText("Cheap helper model") as HTMLSelectElement;
      await waitFor(() => {
        expect(select.value).toBe("__same_as_loop_model__");
      });
    });
  });

  describe("branch selector", () => {
    test("shows 'Select a workspace to load branches' when no branches", () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ branches: [] })} />
      );
      const select = getByLabelText("Base Branch") as HTMLSelectElement;
      const options = Array.from(select.options).map(o => o.text);
      expect(options).toContain("Select a workspace to load branches");
    });

    test("shows 'Loading branches...' when branchesLoading", () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ branchesLoading: true })} />
      );
      const select = getByLabelText("Base Branch") as HTMLSelectElement;
      expect(select).toBeDisabled();
    });

    test("shows default branch with label", () => {
      const branches = [
        createBranchInfo({ name: "main", current: true }),
        createBranchInfo({ name: "feature-a", current: false }),
      ];
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            branches,
            defaultBranch: "main",
            currentBranch: "main",
          })}
        />
      );
      const select = getByLabelText("Base Branch") as HTMLSelectElement;
      const options = Array.from(select.options).map(o => o.text);
      expect(options).toContain("main (default) (current)");
    });

    test("shows current branch separately if different from default", () => {
      const branches = [
        createBranchInfo({ name: "main", current: false }),
        createBranchInfo({ name: "develop", current: true }),
      ];
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            branches,
            defaultBranch: "main",
            currentBranch: "develop",
          })}
        />
      );
      const select = getByLabelText("Base Branch") as HTMLSelectElement;
      const options = Array.from(select.options).map(o => o.text);
      expect(options).toContain("main (default)");
      expect(options).toContain("develop (current)");
    });
  });

  describe("prompt", () => {
    test("title is required", () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      const input = getByLabelText(/Title/) as HTMLInputElement;
      expect(input.required).toBe(true);
    });

    test("prompt is required", () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      const textarea = getByLabelText(/Prompt/) as HTMLTextAreaElement;
      expect(textarea.required).toBe(true);
    });

    test("shows plan mode placeholder when plan mode is on", () => {
      const { getByPlaceholderText } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      expect(
        getByPlaceholderText(/Describe what you want to achieve/)
      ).toBeInTheDocument();
    });

    test("shows execution placeholder when plan mode is off", async () => {
      const { getByRole, getByPlaceholderText, user } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      // Toggle plan mode off
      await user.click(getByRole("checkbox", { name: /Plan Mode/ }));
      expect(
        getByPlaceholderText(/Do everything that's pending/)
      ).toBeInTheDocument();
    });
  });

  describe("plan mode toggle", () => {
    test("plan mode is enabled by default", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      expect((getByRole("checkbox", { name: /Plan Mode/ }) as HTMLInputElement).checked).toBe(true);
    });

    test("plan-mode auto-reply option is not shown", () => {
      const { queryByRole } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );

      expect(queryByRole("checkbox", { name: /Auto-reply plan questions/i })).not.toBeInTheDocument();
    });

    test("auto-accept plan is shown and checked by default", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );

      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).checked).toBe(true);
    });

    test("toggling plan mode keeps the generic Create label in create mode", async () => {
      const { getByRole, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            models: connectedModels(),
            workspaces: testWorkspaces(),
          })}
        />
      );

      expect(getByRole("button", { name: "Create" })).toBeInTheDocument();

      // Toggle off
      await user.click(getByRole("checkbox", { name: /Plan Mode/ }));
      expect(getByRole("button", { name: "Create" })).toBeInTheDocument();
    });

    test("hides auto-accept plan when plan mode is off", async () => {
      const { getByRole, queryByRole, user } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );

      expect(getByRole("checkbox", { name: /Auto-accept plan/i })).toBeInTheDocument();
      await user.click(getByRole("checkbox", { name: /Plan Mode/ }));
      expect(queryByRole("checkbox", { name: /Auto-accept plan/i })).not.toBeInTheDocument();
    });

    test("submit payload no longer includes a plan question auto-reply setting", async () => {
      const onSubmit = mock(async (_req: CreateLoopFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            onSubmit,
            onCancel: mock(() => {}),
            workspaces: testWorkspaces(),
            models: connectedModels(),
            branches: [createBranchInfo({ name: "main" })],
            defaultBranch: "main",
            currentBranch: "main",
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Do it");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Loop title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateLoopRequest;
      expect(req.planMode).toBe(true);
      expect("planModeAutoReply" in req).toBe(false);
    });

    test("submits autoAcceptPlan=true by default in plan mode", async () => {
      const onSubmit = mock(async (_req: CreateLoopFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            onSubmit,
            onCancel: mock(() => {}),
            workspaces: testWorkspaces(),
            models: connectedModels(),
            branches: [createBranchInfo({ name: "main" })],
            defaultBranch: "main",
            currentBranch: "main",
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Do it");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Loop title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateLoopRequest;
      expect(req.planMode).toBe(true);
      expect(req.autoAcceptPlan).toBe(true);
    });

    test("defaults fullyAutonomous to checked for new loops and submits it", async () => {
      const onSubmit = mock(async (_req: CreateLoopFormSubmitRequest) => true);

      const { getByLabelText, getByRole, getAllByRole, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            onSubmit,
            onCancel: mock(() => {}),
            workspaces: testWorkspaces(),
            models: connectedModels(),
            branches: [createBranchInfo({ name: "main" })],
            defaultBranch: "main",
            currentBranch: "main",
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Do it");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Loop title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      const fullyAutonomousCheckbox = getAllByRole("checkbox", { name: /Fully autonomous loop/i })
        .find((element) => !(element as HTMLInputElement).disabled);
      expect(fullyAutonomousCheckbox).toBeDefined();
      expect((fullyAutonomousCheckbox as HTMLInputElement).checked).toBe(true);
      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).checked).toBe(true);
      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).disabled).toBe(true);

      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateLoopRequest;
      expect(req.planMode).toBe(true);
      expect(req.autoAcceptPlan).toBe(true);
      expect(req.fullyAutonomous).toBe(true);
    });

    test("defaults fullyAutonomous to checked for new loops with partial initialLoopData", async () => {
      const onSubmit = mock(async (_req: CreateLoopFormSubmitRequest) => true);

      const { getByLabelText, getByRole, getAllByRole, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            onSubmit,
            onCancel: mock(() => {}),
            initialLoopData: {
              directory: "/workspaces/project-a",
              prompt: "",
              workspaceId: "ws-1",
            },
            workspaces: testWorkspaces(),
            models: connectedModels(),
            branches: [createBranchInfo({ name: "main" })],
            defaultBranch: "main",
            currentBranch: "main",
          })}
        />
      );

      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Do it");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Loop title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      const fullyAutonomousCheckbox = getAllByRole("checkbox", { name: /Fully autonomous loop/i })
        .find((element) => !(element as HTMLInputElement).disabled);
      expect(fullyAutonomousCheckbox).toBeDefined();
      expect((fullyAutonomousCheckbox as HTMLInputElement).checked).toBe(true);
      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).checked).toBe(true);
      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).disabled).toBe(true);

      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateLoopRequest;
      expect(req.workspaceId).toBe("ws-1");
      expect(req.fullyAutonomous).toBe(true);
    });

    test("submits autoAcceptPlan=false when plan mode is disabled", async () => {
      const onSubmit = mock(async (_req: CreateLoopFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            onSubmit,
            onCancel: mock(() => {}),
            workspaces: testWorkspaces(),
            models: connectedModels(),
            branches: [createBranchInfo({ name: "main" })],
            defaultBranch: "main",
            currentBranch: "main",
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Do it");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Loop title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      await user.click(getByRole("checkbox", { name: /Plan Mode/ }));
      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateLoopRequest;
      expect(req.planMode).toBe(false);
      expect(req.autoAcceptPlan).toBe(false);
    });

  });

  describe("advanced options", () => {
    test("advanced options are hidden by default", () => {
      const { queryByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      expect(queryByLabelText("Max Iterations")).not.toBeInTheDocument();
    });

    test("shows advanced options when toggle is clicked", async () => {
      const { getByText, getByLabelText, user } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      await user.click(getByText("Show advanced options"));
      expect(getByLabelText("Max Iterations")).toBeInTheDocument();
      expect(getByLabelText("Max Consecutive Errors")).toBeInTheDocument();
      expect(getByLabelText("Activity Timeout (seconds)")).toBeInTheDocument();
    });

    test("toggle button text changes when expanded", async () => {
      const { getByText, user } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      await user.click(getByText("Show advanced options"));
      expect(getByText("Hide advanced options")).toBeInTheDocument();
    });

    test("shows clear planning folder checkbox in advanced options", async () => {
      const { getByText, getByLabelText, user } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      await user.click(getByText("Show advanced options"));
      expect(getByLabelText(/Clear .\/\.ralph-planning folder/)).toBeInTheDocument();
    });

    test("max consecutive errors defaults to 10", async () => {
      const { getByText, getByLabelText, user } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      await user.click(getByText("Show advanced options"));
      expect((getByLabelText("Max Consecutive Errors") as HTMLInputElement).value).toBe("10");
    });

    test(`activity timeout defaults to ${DEFAULT_LOOP_CONFIG.activityTimeoutSeconds}`, async () => {
      const { getByText, getByLabelText, user } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      await user.click(getByText("Show advanced options"));
      expect((getByLabelText("Activity Timeout (seconds)") as HTMLInputElement).value).toBe(String(DEFAULT_LOOP_CONFIG.activityTimeoutSeconds));
    });
  });

  describe("planning warning", () => {
    test("shows planning warning when Plan Mode is unchecked", () => {
      const { getByText } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            planningWarning: "A .ralph-planning folder already exists",
            initialLoopData: { directory: "/test", prompt: "", planMode: false },
          })}
        />
      );
      expect(getByText("A .ralph-planning folder already exists")).toBeInTheDocument();
    });

    test("does not show warning when null", () => {
      const { queryByText } = renderWithUser(
        <CreateLoopForm {...defaultProps({ planningWarning: null })} />
      );
      expect(queryByText(/\.ralph-planning folder/)).not.toBeInTheDocument();
    });

    test("hides planning warning when Plan Mode is checked (default)", () => {
      const { queryByText } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            planningWarning: "The .ralph-planning directory does not exist.",
          })}
        />
      );
      // Plan Mode defaults to true, so warning should be hidden
      expect(queryByText("The .ralph-planning directory does not exist.")).not.toBeInTheDocument();
    });

    test("toggles warning visibility when Plan Mode checkbox changes", async () => {
      const { queryByText, getByRole, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            planningWarning: "The .ralph-planning directory is empty.",
            initialLoopData: { directory: "/test", prompt: "", planMode: false },
          })}
        />
      );

      // Warning should be visible when Plan Mode is off
      expect(queryByText("The .ralph-planning directory is empty.")).toBeInTheDocument();

      // Enable Plan Mode
      const planModeCheckbox = getByRole("checkbox", { name: /Plan Mode/ });
      await user.click(planModeCheckbox);

      // Warning should disappear
      expect(queryByText("The .ralph-planning directory is empty.")).not.toBeInTheDocument();

      // Disable Plan Mode again
      await user.click(planModeCheckbox);

      // Warning should reappear
      expect(queryByText("The .ralph-planning directory is empty.")).toBeInTheDocument();
    });
  });

  describe("form submission", () => {
    test("submit button is disabled when workspace is not selected", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            models: connectedModels(),
          })}
        />
      );
      expect(getByRole("button", { name: "Create" })).toBeDisabled();
    });

    test("submit button is disabled when model is not selected", async () => {
      const { getByRole, getByLabelText, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      // Select workspace
      const workspaceSelect = getByLabelText("Workspace *") as HTMLSelectElement;
      await user.selectOptions(workspaceSelect, "ws-1");

      // Set prompt value
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Test");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Title");

      // Wait for model auto-selection, then clear it using DOM manipulation
      // (user.selectOptions(select, "") causes OOM on this complex form)
      const modelSelect = getByLabelText("Model") as HTMLSelectElement;
      await waitFor(() => {
        expect(modelSelect.value).not.toBe("");
      });
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(modelSelect, "");
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));

      await waitFor(() => {
        expect(getByRole("button", { name: "Create" })).toBeDisabled();
      });
    });

    test("calls onSubmit with correct request and onCancel on success", async () => {
      const onSubmit = mock(async (_req: CreateLoopFormSubmitRequest) => true);
      const onCancel = mock(() => {});

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            onSubmit,
            onCancel,
            workspaces: testWorkspaces(),
            models: connectedModels(),
            branches: [createBranchInfo({ name: "main" })],
            defaultBranch: "main",
            currentBranch: "main",
          })}
        />
      );

      // Select workspace
      const workspaceSelect = getByLabelText("Workspace *") as HTMLSelectElement;
      await user.selectOptions(workspaceSelect, "ws-1");

      // Set prompt value (using setInputValue to avoid OOM from user.type on complex forms)
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Do it");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Loop title");

      // Wait for model auto-selection
      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      // Submit
      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateLoopRequest;
      expect(req.workspaceId).toBe("ws-1");
      expect(req.name).toBe("Loop title");
      expect(req.prompt).toBe("Do it");
      expect(req.planMode).toBe(true);
      expect(req.useWorktree).toBe(true);
      expect(req.model).toBeDefined();
      expect(req.model.providerID).toBe("anthropic");

      // onCancel should be called on success (closes the modal)
      await waitFor(() => {
        expect(onCancel).toHaveBeenCalledTimes(1);
      });
    });

    test("includes pasted image attachments in the create request", async () => {
      const onSubmit = mock(async (_req: CreateLoopFormSubmitRequest) => true);

      const { getByLabelText, getByRole, getByText, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            onSubmit,
            workspaces: testWorkspaces(),
            models: connectedModels(),
            branches: [createBranchInfo({ name: "main" })],
            defaultBranch: "main",
            currentBranch: "main",
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Use this screenshot");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Loop title");

      pasteFiles(getByLabelText(/Prompt/) as HTMLTextAreaElement, [
        createTestFile({ name: "prompt-image.png" }),
      ]);

      await waitFor(() => {
        expect(getByText("prompt-image.png")).toBeInTheDocument();
      });

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateLoopRequest;
      expect(req.attachments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename: "prompt-image.png",
            mimeType: "image/png",
          }),
        ]),
      );
    });

    test("does not call onCancel when submission fails", async () => {
      const onSubmit = mock(async (_req: CreateLoopFormSubmitRequest) => false);
      const onCancel = mock(() => {});

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            onSubmit,
            onCancel,
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      // Select workspace
      const workspaceSelect = getByLabelText("Workspace *") as HTMLSelectElement;
      await user.selectOptions(workspaceSelect, "ws-1");

      // Set prompt value (using setInputValue to avoid OOM from user.type on complex forms)
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Test");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Loop title");

      // Wait for model auto-selection
      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      // Submit
      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      // onCancel should NOT be called when submission fails
      expect(onCancel).not.toHaveBeenCalled();
    });

    test("external submit action uses the latest multi-character title", async () => {
      const onSubmit = mock(async (_req: CreateLoopFormSubmitRequest) => true);
      let actionState: CreateLoopFormActionState | null = null;

      const { getByLabelText, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            onSubmit,
            renderActions: (state: CreateLoopFormActionState) => {
              actionState = state;
            },
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      const workspaceSelect = getByLabelText("Workspace *") as HTMLSelectElement;
      await user.selectOptions(workspaceSelect, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Do it");

      await waitFor(() => {
        expect(actionState).not.toBeNull();
      });

      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Loop title");

      await waitFor(() => {
        expect(actionState?.canSubmit).toBe(true);
      });

      await act(async () => {
        actionState?.onSubmit();
      });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateLoopRequest;
      expect(req.name).toBe("Loop title");
    });
  });

  describe("save as draft", () => {
    test("renders Save as Draft button", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      expect(getByRole("button", { name: "Save as Draft" })).toBeInTheDocument();
    });

    test("renders actions in cancel, save draft, create order", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );

      const cancelButton = getByRole("button", { name: "Cancel" });
      const saveDraftButton = getByRole("button", { name: "Save as Draft" });
      const createButton = getByRole("button", { name: "Create" });

      expect(cancelButton.compareDocumentPosition(saveDraftButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
      expect(saveDraftButton.compareDocumentPosition(createButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    });

    test("Save as Draft is disabled when workspace is not selected", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      expect(getByRole("button", { name: "Save as Draft" })).toBeDisabled();
    });

    test("calls onSubmit with draft=true", async () => {
      const onSubmit = mock(async (_req: CreateLoopFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            onSubmit,
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      // Fill required fields
      const workspaceSelect = getByLabelText("Workspace *") as HTMLSelectElement;
      await user.selectOptions(workspaceSelect, "ws-1");
      // Set prompt value (using setInputValue to avoid OOM from user.type on complex forms)
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Draft");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Draft title");

      // Wait for model auto-selection
      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      // Click Save as Draft
      await user.click(getByRole("button", { name: "Save as Draft" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateLoopRequest;
      expect(req.draft).toBe(true);
    });

    test("calls onSubmit with useWorktree=false when unchecked", async () => {
      const onSubmit = mock(async (_req: CreateLoopFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            onSubmit,
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      const workspaceSelect = getByLabelText("Workspace *") as HTMLSelectElement;
      await user.selectOptions(workspaceSelect, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "No worktree");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Loop title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      await user.click(getByRole("checkbox", { name: /Use Worktree/ }));
      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateLoopRequest;
      expect(req.useWorktree).toBe(false);
    });

    test("external save-as-draft action uses the latest multi-character title", async () => {
      const onSubmit = mock(async (_req: CreateLoopFormSubmitRequest) => true);
      let actionState: CreateLoopFormActionState | null = null;

      const { getByLabelText, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            onSubmit,
            renderActions: (state: CreateLoopFormActionState) => {
              actionState = state;
            },
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      const workspaceSelect = getByLabelText("Workspace *") as HTMLSelectElement;
      await user.selectOptions(workspaceSelect, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Draft");

      await waitFor(() => {
        expect(actionState).not.toBeNull();
      });

      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Draft title");

      await waitFor(() => {
        expect(actionState?.canSaveDraft).toBe(true);
      });

      await act(async () => {
        actionState?.onSaveAsDraft();
      });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateLoopRequest;
      expect(req.draft).toBe(true);
      expect(req.name).toBe("Draft title");
    });
  });

  describe("edit mode", () => {
    test("pre-populates form fields from initialLoopData", () => {
      const { getByLabelText, getByRole } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            editLoopId: "loop-1",
            initialLoopData: {
              name: "Existing title",
              directory: "/workspaces/project-a",
              prompt: "Existing prompt text",
              model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
              useWorktree: false,
              planMode: false,
              workspaceId: "ws-1",
            },
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      const promptTextarea = getByLabelText(/Prompt/) as HTMLTextAreaElement;
      expect(promptTextarea.value).toBe("Existing prompt text");
      expect((getByLabelText(/Title/) as HTMLInputElement).value).toBe("Existing title");

      const planMode = getByRole("checkbox", { name: /Plan Mode/ }) as HTMLInputElement;
      expect(planMode.checked).toBe(false);
      const useWorktree = getByRole("checkbox", { name: /Use Worktree/ }) as HTMLInputElement;
      expect(useWorktree.checked).toBe(false);
    });

    test("preserves a saved auto-accept=false value in edit mode", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            editLoopId: "loop-1",
            initialLoopData: {
              name: "Existing title",
              directory: "/workspaces/project-a",
              prompt: "Existing prompt text",
              planMode: true,
              autoAcceptPlan: false,
              workspaceId: "ws-1",
            },
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).checked).toBe(false);
    });

    test("preserves a saved fully autonomous value in edit mode", () => {
      const { getByRole, getAllByRole } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            editLoopId: "loop-1",
            initialLoopData: {
              name: "Existing title",
              directory: "/workspaces/project-a",
              prompt: "Existing prompt text",
              planMode: true,
              autoAcceptPlan: true,
              fullyAutonomous: true,
              workspaceId: "ws-1",
            },
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      const fullyAutonomousCheckbox = getAllByRole("checkbox", { name: /Fully autonomous loop/i })
        .find((element) => !(element as HTMLInputElement).disabled);
      expect((fullyAutonomousCheckbox as HTMLInputElement | undefined)?.checked).toBe(true);
      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).checked).toBe(true);
    });

    test("shows the generic Start button in edit mode without plan mode", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            editLoopId: "loop-1",
            initialLoopData: {
              name: "Test Loop",
              directory: "/workspaces/project-a",
              prompt: "Test",
              planMode: false,
              workspaceId: "ws-1",
            },
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );
      expect(getByRole("button", { name: "Start" })).toBeInTheDocument();
    });

    test("shows the generic Start button in edit mode with plan mode", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            editLoopId: "loop-1",
            initialLoopData: {
              name: "Test Loop",
              directory: "/workspaces/project-a",
              prompt: "Test",
              planMode: true,
              workspaceId: "ws-1",
            },
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );
      expect(getByRole("button", { name: "Start" })).toBeInTheDocument();
    });

    test("shows the Update button when editing a draft", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            editLoopId: "loop-1",
            isEditingDraft: true,
            initialLoopData: {
              name: "Test Loop",
              directory: "/workspaces/project-a",
              prompt: "Test",
              workspaceId: "ws-1",
            },
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );
      expect(getByRole("button", { name: "Update" })).toBeInTheDocument();
    });

    test("pre-populates advanced options from initialLoopData", async () => {
      const { getByLabelText, getByText, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            editLoopId: "loop-1",
            initialLoopData: {
              name: "Test Loop",
              directory: "/workspaces/project-a",
              prompt: "Test",
              maxIterations: 5,
              maxConsecutiveErrors: 3,
              activityTimeoutSeconds: 300,
              clearPlanningFolder: true,
              workspaceId: "ws-1",
            },
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      // Show advanced options
      await user.click(getByText("Show advanced options"));

      expect((getByLabelText("Max Iterations") as HTMLInputElement).value).toBe("5");
      expect((getByLabelText("Max Consecutive Errors") as HTMLInputElement).value).toBe("3");
      expect((getByLabelText("Activity Timeout (seconds)") as HTMLInputElement).value).toBe("300");
      expect((getByLabelText(/Clear .\/\.ralph-planning folder/) as HTMLInputElement).checked).toBe(true);
    });
  });

  describe("cancel", () => {
    test("calls onCancel when Cancel button is clicked", async () => {
      const onCancel = mock(() => {});
      const { getByRole, user } = renderWithUser(
        <CreateLoopForm {...defaultProps({ onCancel })} />
      );
      await user.click(getByRole("button", { name: "Cancel" }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("workspace change notification", () => {
    test("calls onWorkspaceChange when workspace is selected", async () => {
      const onWorkspaceChange = mock((_workspaceId: string | null, _directory: string) => {});
      const { getByLabelText, user } = renderWithUser(
        <CreateLoopForm
          {...defaultProps({
            workspaces: testWorkspaces(),
            onWorkspaceChange,
          })}
        />
      );

      const select = getByLabelText("Workspace *") as HTMLSelectElement;
      await user.selectOptions(select, "ws-1");

      await waitFor(() => {
        expect(onWorkspaceChange).toHaveBeenCalled();
        // Last call should have the selected workspace id and directory
        const lastCall = onWorkspaceChange.mock.calls[onWorkspaceChange.mock.calls.length - 1];
        expect(lastCall?.[0]).toBe("ws-1");
      });
    });
  });

  describe("loading state", () => {
    test("disables submit button when loading", () => {
      const { getByRole } = renderWithUser(
        <CreateLoopForm {...defaultProps({ loading: true })} />
      );
      expect(getByRole("button", { name: "Create" })).toBeDisabled();
    });
  });

  describe("template selection", () => {
    test("renders template dropdown with all templates", () => {
      const { getByLabelText } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );
      const select = getByLabelText("Template") as HTMLSelectElement;
      const optionTexts = Array.from(select.options).map(o => o.text);
      // Should have "No template" + all templates
      expect(optionTexts).toContain("No template (custom prompt)");
      for (const template of PROMPT_TEMPLATES) {
        expect(optionTexts).toContain(template.name);
      }
    });

    test("selecting a template updates the textarea value", async () => {
      const { getByLabelText, user } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );

      const templateSelect = getByLabelText("Template") as HTMLSelectElement;
      const textarea = getByLabelText(/Prompt/) as HTMLTextAreaElement;

      // Select the "Fix Failing Tests" template
      await user.selectOptions(templateSelect, "fix-failing-tests");

      const template = getTemplateById("fix-failing-tests")!;
      await waitFor(() => {
        expect(textarea.value).toBe(template.prompt);
      });
    });

    test("selecting a template sets planMode from template defaults", async () => {
      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );

      const templateSelect = getByLabelText("Template") as HTMLSelectElement;
      const planModeCheckbox = getByRole("checkbox", { name: /Plan Mode/ }) as HTMLInputElement;

      // Default plan mode is true
      expect(planModeCheckbox.checked).toBe(true);

      // Select "Fix Failing Tests" — its defaults.planMode is false
      await user.selectOptions(templateSelect, "fix-failing-tests");

      await waitFor(() => {
        expect(planModeCheckbox.checked).toBe(false);
      });

      // Now select "Thorough Code Review" — its defaults.planMode is true
      await user.selectOptions(templateSelect, "thorough-code-review");

      await waitFor(() => {
        expect(planModeCheckbox.checked).toBe(true);
      });
    });

    test("modifying the textarea clears the selected template", async () => {
      const { getByLabelText, user } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );

      const templateSelect = getByLabelText("Template") as HTMLSelectElement;
      const textarea = getByLabelText(/Prompt/) as HTMLTextAreaElement;

      // Select a template first
      await user.selectOptions(templateSelect, "continue-planned-tasks");

      await waitFor(() => {
        expect(templateSelect.value).toBe("continue-planned-tasks");
      });

      // Type a character in the textarea to modify the prompt
      // This uses user.type() with a single char to trigger React's onChange
      await user.type(textarea, "X");

      // Template selection should be cleared since prompt diverged from template text
      await waitFor(() => {
        expect(templateSelect.value).toBe("");
      });
    });

    test("shows template description when a template is selected", async () => {
      const { getByLabelText, getByText, user } = renderWithUser(
        <CreateLoopForm {...defaultProps()} />
      );

      const templateSelect = getByLabelText("Template") as HTMLSelectElement;

      // Select a template
      await user.selectOptions(templateSelect, "thorough-code-review");

      const template = getTemplateById("thorough-code-review")!;
      await waitFor(() => {
        expect(getByText(template.description)).toBeInTheDocument();
      });
    });
  });
});
