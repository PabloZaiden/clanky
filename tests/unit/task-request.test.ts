import { describe, expect, test } from "bun:test";

import { toDraftTaskUpdateRequest } from "../../src/lib/task-request";
import type { CreateTaskRequest } from "../../src/types";

describe("toDraftTaskUpdateRequest", () => {
  test("omits create-only fields and preserves explicit unlimited iterations", () => {
    const request: CreateTaskRequest = {
      name: "Draft task",
      workspaceId: "ws-1",
      prompt: "Refine the draft",
      attachments: [],
      model: {
        providerID: "copilot",
        modelID: "mock-model",
        variant: "",
      },
      cheapModel: { mode: "same-as-task" },
      maxIterations: null,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: null,
      stopPattern: "<promise>COMPLETE</promise>$",
      git: {
        branchPrefix: "",
        commitScope: "",
      },
      baseBranch: "main",
      useWorktree: true,
      clearPlanningFolder: false,
      planMode: false,
      autoAcceptPlan: false,
      fullyAutonomous: false,
      draft: true,
    };

    expect(toDraftTaskUpdateRequest(request)).toEqual({
      name: "Draft task",
      prompt: "Refine the draft",
      model: {
        providerID: "copilot",
        modelID: "mock-model",
        variant: "",
      },
      cheapModel: { mode: "same-as-task" },
      maxIterations: null,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: null,
      stopPattern: "<promise>COMPLETE</promise>$",
      git: {
        branchPrefix: "",
        commitScope: "",
      },
      baseBranch: "main",
      useWorktree: true,
      clearPlanningFolder: false,
      planMode: false,
      autoAcceptPlan: false,
      fullyAutonomous: false,
    });
  });
});
