/**
 * Tests for the CreateTaskForm component.
 *
 * CreateTaskForm is a complex form for creating new Clanky Tasks,
 * including workspace/model/branch selection, plan mode toggle,
 * advanced options, and draft saving.
 */

import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { CreateTaskForm, type CreateTaskFormActionState } from "@/components/CreateTaskForm";
import type { CreateTaskFormSubmitRequest } from "@/types/task-request";
import { renderWithUser, waitFor, act } from "../helpers/render";
import {
  createModelInfo,
  createBranchInfo,
  createWorkspace,
} from "../helpers/factories";
import { createMockApi } from "../helpers/mock-api";
import type { ModelInfo, CreateTaskRequest } from "@/types";
import type { Workspace } from "@/types/workspace";
import { PROMPT_TEMPLATES, getTemplateById } from "@/lib/prompt-templates";
import {
  createTestFile,
  installImageAttachmentMocks,
  pasteFiles,
} from "../helpers/image-paste";

installImageAttachmentMocks();
const api = createMockApi();
const TASK_MODEL_STORAGE_KEY = "clanky.taskModelPreference";
const TASK_CHEAP_MODEL_STORAGE_KEY = "clanky.taskCheapModelPreference";

beforeEach(() => {
  api.reset();
  api.install();
});

afterEach(() => {
  api.uninstall();
});

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
function defaultProps(overrides?: Partial<Parameters<typeof CreateTaskForm>[0]>) {
  return {
    onSubmit: mock(async (_req: CreateTaskFormSubmitRequest) => true),
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

describe("CreateTaskForm", () => {
  describe("model selector", () => {
    test("groups models by provider", () => {
      const { getByLabelText } = renderWithUser(
        <CreateTaskForm {...defaultProps({ models: connectedModels() })} />
      );
      const select = getByLabelText("Model") as HTMLSelectElement;
      const optgroups = select.querySelectorAll("optgroup");
      const labels = Array.from(optgroups).map(g => g.label);
      expect(labels).toContain("Anthropic");
      expect(labels).toContain("OpenAI");
    });

    test("auto-selects first connected model", async () => {
      const { getByLabelText } = renderWithUser(
        <CreateTaskForm {...defaultProps({ models: connectedModels() })} />
      );
      const select = getByLabelText("Model") as HTMLSelectElement;
      // Should auto-select first connected model (Anthropic - sorted alphabetically)
      await waitFor(() => {
        expect(select.value).toBe("anthropic:claude-sonnet-4-20250514:");
      });
    });

    test("auto-selects lastModel when provided", async () => {
      const models = connectedModels();
      const lastModel = { providerID: "openai", modelID: "gpt-4o", variant: "" };

      const { getByLabelText } = renderWithUser(
        <CreateTaskForm {...defaultProps({ models, lastModel })} />
      );
      const select = getByLabelText("Model") as HTMLSelectElement;
      await waitFor(() => {
        expect(select.value).toBe("openai:gpt-4o:");
      });
    });

    test("prefers the locally stored task model over the server fallback", async () => {
      window.localStorage.setItem(
        TASK_MODEL_STORAGE_KEY,
        JSON.stringify({
          providerID: "anthropic",
          modelID: "claude-sonnet",
          variant: "standard",
        }),
      );
      const models = [
        createModelInfo({
          providerID: "anthropic",
          modelID: "claude-sonnet",
          modelName: "Claude Sonnet",
          providerName: "Anthropic",
          connected: true,
          variants: ["fast", "standard"],
        }),
        createModelInfo({
          providerID: "openai",
          modelID: "gpt-4o",
          modelName: "GPT-4o",
          providerName: "OpenAI",
          connected: true,
        }),
      ];

      const { getByLabelText } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            models,
            lastModel: { providerID: "openai", modelID: "gpt-4o", variant: "" },
          })}
        />,
      );
      const select = getByLabelText("Model") as HTMLSelectElement;

      await waitFor(() => {
        expect(select.value).toBe("anthropic:claude-sonnet:standard");
      });
    });

    test("falls back to lastModel when the locally stored task model is malformed", async () => {
      window.localStorage.setItem(TASK_MODEL_STORAGE_KEY, "{bad json");
      const models = connectedModels();

      const { getByLabelText } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            models,
            lastModel: { providerID: "openai", modelID: "gpt-4o", variant: "" },
          })}
        />,
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
        <CreateTaskForm {...defaultProps({ models })} />
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
        <CreateTaskForm {...defaultProps({ models })} />
      );
      
      const select = getByLabelText("Model") as HTMLSelectElement;
      
      // Wait for auto-selection, then clear it using DOM manipulation
      await waitFor(() => {
        expect(select.value).not.toBe("");
      });
      
      // Use direct DOM manipulation to clear the selection (same pattern as TaskActionBar tests)
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, "");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      
      await waitFor(() => {
        expect(getByText("Model is required. Please select a model.")).toBeInTheDocument();
      });
    });

    test("disables title generation until a valid model is selected", async () => {
      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateTaskForm
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
        <CreateTaskForm {...defaultProps({ models })} />
      );
      const select = getByLabelText("Model") as HTMLSelectElement;
      const optionTexts = Array.from(select.options).map(o => o.text);
      expect(optionTexts).toContain("Claude Sonnet (fast)");
      expect(optionTexts).toContain("Claude Sonnet (standard)");
    });

    test("defaults the cheap helper model to same-as-task", async () => {
      const { getByLabelText, getByText, user } = renderWithUser(
        <CreateTaskForm {...defaultProps({ models: connectedModels() })} />
      );

      await user.click(getByText("Show advanced options"));

      const select = getByLabelText("Cheap helper model") as HTMLSelectElement;
      await waitFor(() => {
        expect(select.value).toBe("__same_as_task_model__");
      });

      const optionTexts = Array.from(select.options).map((option) => option.text);
      expect(optionTexts).toContain("Same as task model");
    });

    test("prefers the locally stored cheap helper model over the server fallback", async () => {
      window.localStorage.setItem(
        TASK_CHEAP_MODEL_STORAGE_KEY,
        JSON.stringify({
          mode: "custom",
          model: {
            providerID: "openai",
            modelID: "gpt-4o",
            variant: "",
          },
        }),
      );
      const { getByLabelText, getByText, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            models: connectedModels(),
            lastCheapModel: { mode: "same-as-task" },
          })}
        />,
      );

      await user.click(getByText("Show advanced options"));

      const select = getByLabelText("Cheap helper model") as HTMLSelectElement;
      await waitFor(() => {
        expect(select.value).toBe("openai:gpt-4o:");
      });
    });

    test("falls back to same-as-task when the remembered cheap model is unavailable", async () => {
      const { getByLabelText, getByText, user } = renderWithUser(
        <CreateTaskForm
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
        expect(select.value).toBe("__same_as_task_model__");
      });
    });
  });

  describe("branch selector", () => {
  });

  describe("prompt", () => {
    test("title is optional when creating a new task", () => {
      const { getByLabelText, getByText } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
      );
      const input = getByLabelText(/Title/) as HTMLInputElement;
      expect(input.required).toBe(false);
      expect(input.getAttribute("aria-required")).toBe("false");
      expect(
        getByText("You can leave the title blank when first creating or saving a draft, or let AI suggest one from the current prompt. A title is required for edits.")
      ).toBeInTheDocument();
    });

    test("title is required when editing a task", () => {
      const { getByLabelText, getByText } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            editTaskId: "task-1",
            initialTaskData: {
              name: "Existing title",
              directory: "/workspaces/project-a",
              prompt: "Existing prompt text",
              workspaceId: "ws-1",
            },
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );
      const input = getByLabelText(/Title/) as HTMLInputElement;
      expect(input.required).toBe(true);
      expect(input.getAttribute("aria-required")).toBe("true");
      expect(
        getByText("A title is required when editing. You can still let AI suggest one from the current prompt.")
      ).toBeInTheDocument();
    });

    test("prompt is required", () => {
      const { getByLabelText } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
      );
      const textarea = getByLabelText(/Prompt/) as HTMLTextAreaElement;
      expect(textarea.required).toBe(true);
    });

    test("shows plan mode placeholder when plan mode is on", () => {
      const { getByPlaceholderText } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
      );
      expect(
        getByPlaceholderText(/Describe what you want to achieve/)
      ).toBeInTheDocument();
    });

    test("shows execution placeholder when plan mode is off", async () => {
      const { getByRole, getByPlaceholderText, user } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
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
        <CreateTaskForm {...defaultProps()} />
      );
      expect((getByRole("checkbox", { name: /Plan Mode/ }) as HTMLInputElement).checked).toBe(true);
    });

    test("plan-mode auto-reply option is not shown", () => {
      const { queryByRole } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
      );

      expect(queryByRole("checkbox", { name: /Auto-reply plan questions/i })).not.toBeInTheDocument();
    });

    test("auto-accept plan is shown and checked by default", () => {
      const { getByRole } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
      );

      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).checked).toBe(true);
    });

    test("toggling plan mode keeps the generic Create label in create mode", async () => {
      const { getByRole, user } = renderWithUser(
        <CreateTaskForm
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
        <CreateTaskForm {...defaultProps()} />
      );

      expect(getByRole("checkbox", { name: /Auto-accept plan/i })).toBeInTheDocument();
      await user.click(getByRole("checkbox", { name: /Plan Mode/ }));
      expect(queryByRole("checkbox", { name: /Auto-accept plan/i })).not.toBeInTheDocument();
    });

    test("submit payload no longer includes a plan question auto-reply setting", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateTaskForm
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
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Task title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.planMode).toBe(true);
      expect("planModeAutoReply" in req).toBe(false);
    });

    test("submits autoAcceptPlan=true by default in plan mode", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateTaskForm
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
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Task title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.planMode).toBe(true);
      expect(req.autoAcceptPlan).toBe(true);
    });

    test("defaults fullyAutonomous to checked for new tasks and submits it", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, getAllByRole, user } = renderWithUser(
        <CreateTaskForm
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
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Task title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      const fullyAutonomousCheckbox = getAllByRole("checkbox", { name: /Fully autonomous task/i })
        .find((element) => !(element as HTMLInputElement).disabled);
      expect(fullyAutonomousCheckbox).toBeDefined();
      expect((fullyAutonomousCheckbox as HTMLInputElement).checked).toBe(true);
      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).checked).toBe(true);
      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).disabled).toBe(true);

      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.planMode).toBe(true);
      expect(req.autoAcceptPlan).toBe(true);
      expect(req.fullyAutonomous).toBe(true);
    });

    test("defaults fullyAutonomous to checked for new tasks with partial initialTaskData", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, getAllByRole, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            onSubmit,
            onCancel: mock(() => {}),
            initialTaskData: {
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
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Task title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      const fullyAutonomousCheckbox = getAllByRole("checkbox", { name: /Fully autonomous task/i })
        .find((element) => !(element as HTMLInputElement).disabled);
      expect(fullyAutonomousCheckbox).toBeDefined();
      expect((fullyAutonomousCheckbox as HTMLInputElement).checked).toBe(true);
      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).checked).toBe(true);
      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).disabled).toBe(true);

      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.workspaceId).toBe("ws-1");
      expect(req.fullyAutonomous).toBe(true);
    });

    test("submits autoAcceptPlan=false when plan mode is disabled", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateTaskForm
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
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Task title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      await user.click(getByRole("checkbox", { name: /Plan Mode/ }));
      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.planMode).toBe(false);
      expect(req.autoAcceptPlan).toBe(false);
    });

  });

  describe("advanced options", () => {
    test("advanced options are hidden by default", () => {
      const { queryByLabelText } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
      );
      expect(queryByLabelText("Max Iterations")).not.toBeInTheDocument();
    });

    test("shows advanced options when toggle is clicked", async () => {
      const { getByText, getByLabelText, user } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
      );
      await user.click(getByText("Show advanced options"));
      expect(getByLabelText("Max Iterations")).toBeInTheDocument();
      expect(getByLabelText("Max Consecutive Errors")).toBeInTheDocument();
      expect(getByLabelText("Activity Timeout (seconds)")).toBeInTheDocument();
    });

    test("toggle button text changes when expanded", async () => {
      const { getByText, user } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
      );
      await user.click(getByText("Show advanced options"));
      expect(getByText("Hide advanced options")).toBeInTheDocument();
    });

    test("shows clear planning folder checkbox in advanced options", async () => {
      const { getByText, getByLabelText, user } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
      );
      await user.click(getByText("Show advanced options"));
      expect(getByLabelText(/Clear .\/\.clanky-planning folder/)).toBeInTheDocument();
    });

    test("max consecutive errors defaults to 10", async () => {
      const { getByText, getByLabelText, user } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
      );
      await user.click(getByText("Show advanced options"));
      expect((getByLabelText("Max Consecutive Errors") as HTMLInputElement).value).toBe("10");
    });

    test("activity timeout defaults to unlimited", async () => {
      const { getByText, getByLabelText, user } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
      );
      await user.click(getByText("Show advanced options"));
      expect((getByLabelText("Activity Timeout (seconds)") as HTMLInputElement).value).toBe("");
    });
  });

  describe("planning warning", () => {
    test("shows planning warning when Plan Mode is unchecked", () => {
      const { getByText } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            planningWarning: "A .clanky-planning folder already exists",
            initialTaskData: { directory: "/test", prompt: "", planMode: false },
          })}
        />
      );
      expect(getByText("A .clanky-planning folder already exists")).toBeInTheDocument();
    });

    test("does not show warning when null", () => {
      const { queryByText } = renderWithUser(
        <CreateTaskForm {...defaultProps({ planningWarning: null })} />
      );
      expect(queryByText(/\.clanky-planning folder/)).not.toBeInTheDocument();
    });

    test("hides planning warning when Plan Mode is checked (default)", () => {
      const { queryByText } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            planningWarning: "The .clanky-planning directory does not exist.",
          })}
        />
      );
      // Plan Mode defaults to true, so warning should be hidden
      expect(queryByText("The .clanky-planning directory does not exist.")).not.toBeInTheDocument();
    });

    test("toggles warning visibility when Plan Mode checkbox changes", async () => {
      const { queryByText, getByRole, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            planningWarning: "The .clanky-planning directory is empty.",
            initialTaskData: { directory: "/test", prompt: "", planMode: false },
          })}
        />
      );

      // Warning should be visible when Plan Mode is off
      expect(queryByText("The .clanky-planning directory is empty.")).toBeInTheDocument();

      // Enable Plan Mode
      const planModeCheckbox = getByRole("checkbox", { name: /Plan Mode/ });
      await user.click(planModeCheckbox);

      // Warning should disappear
      expect(queryByText("The .clanky-planning directory is empty.")).not.toBeInTheDocument();

      // Disable Plan Mode again
      await user.click(planModeCheckbox);

      // Warning should reappear
      expect(queryByText("The .clanky-planning directory is empty.")).toBeInTheDocument();
    });
  });

  describe("form submission", () => {
    test("submit button is disabled when workspace is not selected", () => {
      const { getByRole } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            models: connectedModels(),
          })}
        />
      );
      expect(getByRole("button", { name: "Create" })).toBeDisabled();
    });

    test("submit button is disabled when model is not selected", async () => {
      const { getByRole, getByLabelText, user } = renderWithUser(
        <CreateTaskForm
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

    test("submit button is enabled for new tasks without a title when other fields are valid", async () => {
      const { getByRole, getByLabelText, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Test");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      expect(getByRole("button", { name: "Create" })).toBeEnabled();
      expect(getByRole("button", { name: "Save as Draft" })).toBeEnabled();
    });

    test("create auto-generates a missing title before submitting", async () => {
      api.post("/api/tasks/title", () => ({ title: "Generated Task Title" }));
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            onSubmit,
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Do it");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      expect(api.calls("/api/tasks/title", "POST").length).toBe(1);
      expect((getByLabelText(/Title/) as HTMLInputElement).value).toBe("Generated Task Title");

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.name).toBe("Generated Task Title");
    });

    test("create stops when auto-title generation fails", async () => {
      api.post("/api/tasks/title", () => ({ message: "Title generation failed" }), 500);
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, getByText, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            onSubmit,
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Do it");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(getByText("Title generation failed")).toBeInTheDocument();
      });

      expect(api.calls("/api/tasks/title", "POST").length).toBe(1);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    test("calls onSubmit with correct request and onCancel on success", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);
      const onCancel = mock(() => {});

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateTaskForm
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
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Task title");

      // Wait for model auto-selection
      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      // Submit
      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.workspaceId).toBe("ws-1");
      expect(req.name).toBe("Task title");
      expect(req.prompt).toBe("Do it");
      expect(req.planMode).toBe(true);
      expect(req.useWorktree).toBe(true);
      expect(req.model).toBeDefined();
      expect(req.model.providerID).toBe("anthropic");
      expect(req.activityTimeoutSeconds).toBeNull();

      // onCancel should be called on success (closes the modal)
      await waitFor(() => {
        expect(onCancel).toHaveBeenCalledTimes(1);
      });
    });

    test("includes pasted image attachments in the create request", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, getByText, user } = renderWithUser(
        <CreateTaskForm
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
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Task title");

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

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
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
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => false);
      const onCancel = mock(() => {});

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateTaskForm
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
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Task title");

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
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);
      let actionState: CreateTaskFormActionState | null = null;

      const { getByLabelText, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            onSubmit,
            renderActions: (state: CreateTaskFormActionState) => {
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

      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Task title");

      await waitFor(() => {
        expect(actionState?.canSubmit).toBe(true);
      });

      await act(async () => {
        actionState?.onSubmit();
      });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.name).toBe("Task title");
    });

    test("external submit action auto-generates a missing title", async () => {
      api.post("/api/tasks/title", () => ({ title: "Generated Task Title" }));
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);
      let actionState: CreateTaskFormActionState | null = null;

      const { getByLabelText, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            onSubmit,
            renderActions: (state: CreateTaskFormActionState) => {
              actionState = state;
            },
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Do it");

      await waitFor(() => {
        expect(actionState?.canSubmit).toBe(true);
      });

      await act(async () => {
        actionState?.onSubmit();
      });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      expect(api.calls("/api/tasks/title", "POST").length).toBe(1);

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.name).toBe("Generated Task Title");
    });

    test("submits a finite activity timeout when one is entered", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, getByText, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            onSubmit,
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Do it");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Task title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      await user.click(getByText("Show advanced options"));
      await setInputValue(user, getByLabelText("Activity Timeout (seconds)") as HTMLInputElement, "120");

      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.activityTimeoutSeconds).toBe(120);
    });
  });

  describe("save as draft", () => {
    test("Save as Draft is disabled when workspace is not selected", () => {
      const { getByRole } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
      );
      expect(getByRole("button", { name: "Save as Draft" })).toBeDisabled();
    });

    test("Save as Draft is disabled for a blank title when title generation is unavailable", async () => {
      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            workspaces: testWorkspaces(),
            models: [],
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Draft");

      expect(getByRole("button", { name: "Save as Draft" })).toBeDisabled();
    });

    test("calls onSubmit with draft=true", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateTaskForm
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

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.draft).toBe(true);
    });

    test("save as draft auto-generates a missing title before submitting", async () => {
      api.post("/api/tasks/title", () => ({ title: "Generated Draft Title" }));
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            onSubmit,
            workspaces: testWorkspaces(),
            models: connectedModels(),
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Draft");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
        expect(getByRole("button", { name: "Save as Draft" })).toBeEnabled();
      });

      await user.click(getByRole("button", { name: "Save as Draft" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      expect(api.calls("/api/tasks/title", "POST").length).toBe(1);
      expect((getByLabelText(/Title/) as HTMLInputElement).value).toBe("Generated Draft Title");

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskFormSubmitRequest;
      expect(req.draft).toBe(true);
      expect(req.name).toBe("Generated Draft Title");
    });

    test("saves a draft without a selected model", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            onSubmit,
            workspaces: testWorkspaces(),
            models: [],
          })}
        />
      );

      await user.selectOptions(getByLabelText("Workspace *") as HTMLSelectElement, "ws-1");
      await setInputValue(user, getByLabelText(/Prompt/) as HTMLTextAreaElement, "Draft");
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Draft title");

      await waitFor(() => {
        expect(getByRole("button", { name: "Save as Draft" })).toBeEnabled();
      });

      await user.click(getByRole("button", { name: "Save as Draft" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskFormSubmitRequest;
      expect(req.draft).toBe(true);
      expect(req.model).toBeUndefined();
    });

    test("calls onSubmit with useWorktree=false when unchecked", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);

      const { getByLabelText, getByRole, user } = renderWithUser(
        <CreateTaskForm
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
      await setInputValue(user, getByLabelText(/Title/) as HTMLInputElement, "Task title");

      await waitFor(() => {
        expect((getByLabelText("Model") as HTMLSelectElement).value).not.toBe("");
      });

      await user.click(getByRole("checkbox", { name: /Use Worktree/ }));
      await user.click(getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.useWorktree).toBe(false);
    });

    test("external save-as-draft action uses the latest multi-character title", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);
      let actionState: CreateTaskFormActionState | null = null;

      const { getByLabelText, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            onSubmit,
            renderActions: (state: CreateTaskFormActionState) => {
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

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.draft).toBe(true);
      expect(req.name).toBe("Draft title");
    });
  });

  describe("edit mode", () => {
    test("pre-populates form fields from initialTaskData", () => {
      const { getByLabelText, getByRole } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            editTaskId: "task-1",
            initialTaskData: {
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
        <CreateTaskForm
          {...defaultProps({
            editTaskId: "task-1",
            initialTaskData: {
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
        <CreateTaskForm
          {...defaultProps({
            editTaskId: "task-1",
            initialTaskData: {
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

      const fullyAutonomousCheckbox = getAllByRole("checkbox", { name: /Fully autonomous task/i })
        .find((element) => !(element as HTMLInputElement).disabled);
      expect((fullyAutonomousCheckbox as HTMLInputElement | undefined)?.checked).toBe(true);
      expect((getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).checked).toBe(true);
    });

    test("shows the generic Start button in edit mode without plan mode", () => {
      const { getByRole } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            editTaskId: "task-1",
            initialTaskData: {
              name: "Test Task",
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
        <CreateTaskForm
          {...defaultProps({
            editTaskId: "task-1",
            initialTaskData: {
              name: "Test Task",
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
        <CreateTaskForm
          {...defaultProps({
            editTaskId: "task-1",
            isEditingDraft: true,
            initialTaskData: {
              name: "Test Task",
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

    test("allows draft updates even when the current model is disconnected", async () => {
      const onSubmit = mock(async (_req: CreateTaskFormSubmitRequest) => true);
      let actionState: CreateTaskFormActionState | null = null;

      const disconnectedDraftModel = createModelInfo({
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
        modelName: "Claude Sonnet 4",
        providerName: "Anthropic",
        connected: false,
      });

      renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            onSubmit,
            editTaskId: "task-1",
            isEditingDraft: true,
            initialTaskData: {
              name: "Draft task",
              directory: "/workspaces/project-a",
              prompt: "Refine the draft",
              model: {
                providerID: disconnectedDraftModel.providerID,
                modelID: disconnectedDraftModel.modelID,
                variant: "",
              },
              workspaceId: "ws-1",
            },
            renderActions: (state: CreateTaskFormActionState) => {
              actionState = state;
            },
            workspaces: testWorkspaces(),
            models: [disconnectedDraftModel],
          })}
        />
      );

      await waitFor(() => {
        expect(actionState?.canSaveDraft).toBe(true);
        expect(actionState?.canSubmit).toBe(false);
      });

      await act(async () => {
        actionState?.onSaveAsDraft();
      });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });

      const req = onSubmit.mock.calls[0]?.[0] as CreateTaskRequest;
      expect(req.draft).toBe(true);
      expect(req.model).toEqual({
        providerID: disconnectedDraftModel.providerID,
        modelID: disconnectedDraftModel.modelID,
        variant: "",
      });
    });

    test("pre-populates advanced options from initialTaskData", async () => {
      const { getByLabelText, getByText, user } = renderWithUser(
        <CreateTaskForm
          {...defaultProps({
            editTaskId: "task-1",
            initialTaskData: {
              name: "Test Task",
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
      expect((getByLabelText(/Clear .\/\.clanky-planning folder/) as HTMLInputElement).checked).toBe(true);
    });
  });

  describe("cancel", () => {
    test("calls onCancel when Cancel button is clicked", async () => {
      const onCancel = mock(() => {});
      const { getByRole, user } = renderWithUser(
        <CreateTaskForm {...defaultProps({ onCancel })} />
      );
      await user.click(getByRole("button", { name: "Cancel" }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("workspace change notification", () => {
    test("calls onWorkspaceChange when workspace is selected", async () => {
      const onWorkspaceChange = mock((_workspaceId: string | null, _directory: string) => {});
      const { getByLabelText, user } = renderWithUser(
        <CreateTaskForm
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
        <CreateTaskForm {...defaultProps({ loading: true })} />
      );
      expect(getByRole("button", { name: "Create" })).toBeDisabled();
    });
  });

  describe("template selection", () => {
    test("renders template dropdown with all templates", () => {
      const { getByLabelText } = renderWithUser(
        <CreateTaskForm {...defaultProps()} />
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
        <CreateTaskForm {...defaultProps()} />
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
        <CreateTaskForm {...defaultProps()} />
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
        <CreateTaskForm {...defaultProps()} />
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
        <CreateTaskForm {...defaultProps()} />
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
