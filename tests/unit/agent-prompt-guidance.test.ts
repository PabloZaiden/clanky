import { describe, expect, test } from "bun:test";
import { buildLoopPrompt, type PromptBuildContext } from "../../src/core/engine/engine-prompt";
import { StopPatternDetector } from "../../src/core/engine/engine-helpers";
import { buildAcceptedPlanExecutionPrompt } from "../../src/core/loop/loop-plan-mode";
import { constructAutomaticPrReviewPrompt } from "../../src/core/loop/loop-review";
import { constructReviewPrompt } from "../../src/core/loop/review-engine";
import { PROMPT_TEMPLATES } from "../../src/lib/prompt-templates";
import { DEFAULT_LOOP_CONFIG, type LoopConfig, type LoopState } from "../../src/types/loop";
import type { PromptInput } from "../../src/backends/types";

function createExecutionPromptContext(): PromptBuildContext {
  const config: LoopConfig = {
    id: "test-loop",
    name: "Test Loop",
    directory: "/workspaces/demo/repo",
    prompt: "Remove repository-guidance instructions from prompts",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceId: "workspace-1",
    model: {
      providerID: "test-provider",
      modelID: "test-model",
      variant: "",
    },
    stopPattern: "<promise>COMPLETE</promise>$",
    git: { branchPrefix: "", commitScope: "" },
    maxIterations: 3,
    maxConsecutiveErrors: 3,
    activityTimeoutSeconds: DEFAULT_LOOP_CONFIG.activityTimeoutSeconds,
    useWorktree: DEFAULT_LOOP_CONFIG.useWorktree,
    clearPlanningFolder: false,
    planMode: false,
    mode: "loop",
  };

  const state: LoopState = {
    id: config.id,
    status: "running",
    currentIteration: 1,
    recentIterations: [],
    logs: [],
    messages: [],
    toolCalls: [],
  };

  return {
    config,
    state,
    workingDirectory: config.directory,
    stopDetector: new StopPatternDetector(config.stopPattern),
    emitUserMessage: () => {},
    emitLog: () => "log-id",
    updateState: () => {},
    consumeInitialPromptAttachments: () => [],
    consumePendingPromptAttachments: () => [],
  };
}

function getPromptText(prompt: PromptInput): string {
  return prompt.parts
    .filter((part): part is Extract<PromptInput["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("Agent prompt guidance", () => {
  test("execution prompt no longer instructs the agent to read AGENTS.md", () => {
    const prompt = buildLoopPrompt(createExecutionPromptContext(), 1);
    const text = getPromptText(prompt);

    expect(text).not.toContain("AGENTS.md");
    expect(text).toContain("./.ralph-planning");
    expect(text).toContain("established project conventions");
  });

  test("accepted-plan execution prompt no longer references AGENTS.md", () => {
    const prompt = buildAcceptedPlanExecutionPrompt();

    expect(prompt).not.toContain("AGENTS.md");
    expect(prompt).toContain(".ralph-planning/plan.md");
    expect(prompt).toContain(".ralph-planning/status.md");
  });

  test("review prompts no longer reference AGENTS.md", () => {
    const reviewPrompt = constructReviewPrompt("Please add tests.");
    const automaticReviewPrompt = constructAutomaticPrReviewPrompt([
      {
        text: "Add a regression test.",
        sourceItemIds: ["thread-1"],
      },
    ], [
      {
        id: "thread-1",
        source: "review_thread",
        body: "Add a regression test.",
        authorLogin: "reviewer",
        path: "src/example.ts",
        line: 10,
      },
    ]);

    expect(reviewPrompt).not.toContain("AGENTS.md");
    expect(reviewPrompt).toContain(".ralph-planning/status.md");
    expect(automaticReviewPrompt).not.toContain("AGENTS.md");
    expect(automaticReviewPrompt).toContain(".ralph-planning/status.md");
  });

  test("predefined prompt templates no longer mention AGENTS.md", () => {
    for (const template of PROMPT_TEMPLATES) {
      expect(template.prompt).not.toContain("AGENTS.md");
    }
  });
});
