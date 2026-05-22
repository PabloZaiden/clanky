import { describe, expect, test } from "bun:test";
import {
  buildTaskBranchName,
  buildReviewBranchName,
  normalizeBranchPrefix,
} from "../../src/core/branch-name";

describe("branch-name helpers", () => {
  test("buildTaskBranchName creates title-plus-hash branch names", () => {
    expect(buildTaskBranchName("My Feature", "Test prompt")).toBe("my-feature-46817f3");
  });

  test("buildTaskBranchName sanitizes the title before appending the prompt hash", () => {
    expect(buildTaskBranchName("Team / Infra", "Test prompt")).toBe("team-infra-46817f3");
  });

  test("normalizeBranchPrefix strips invalid characters and empty segments", () => {
    expect(normalizeBranchPrefix(" Team / Infra Tools / ")).toBe("team/infra-tools/");
  });

  test("buildReviewBranchName appends the review cycle to the base branch", () => {
    expect(buildReviewBranchName("my-feature-46817f3", 2)).toBe("my-feature-46817f3-review-2");
  });
});
