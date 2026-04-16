import { describe, expect, test } from "bun:test";

import { toDraftLoopUpdateRequest } from "../../src/lib/loop-request";
import type { CreateLoopRequest } from "../../src/types";

describe("toDraftLoopUpdateRequest", () => {
  test("omits create-only fields and normalizes unlimited iterations", () => {
    const request: CreateLoopRequest = {
      name: "Draft loop",
      workspaceId: "ws-1",
      prompt: "Refine the draft",
      attachments: [],
      model: {
        providerID: "copilot",
        modelID: "mock-model",
        variant: "",
      },
      cheapModel: { mode: "same-as-loop" },
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

    expect(toDraftLoopUpdateRequest(request)).toEqual({
      name: "Draft loop",
      prompt: "Refine the draft",
      model: {
        providerID: "copilot",
        modelID: "mock-model",
        variant: "",
      },
      cheapModel: { mode: "same-as-loop" },
      maxIterations: undefined,
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
