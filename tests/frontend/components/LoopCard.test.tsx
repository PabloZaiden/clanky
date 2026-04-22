/**
 * Tests for the LoopCard component.
 */

import { test, expect, describe } from "bun:test";
import { mock } from "bun:test";
import { LoopCard } from "@/components/LoopCard";
import { renderWithUser } from "../helpers/render";
import {
  createLoop,
  createLoopWithStatus,
  createGitState,
  createGitCommit,
  createLoopError,
} from "../helpers/factories";

describe("LoopCard", () => {
  describe("basic rendering", () => {
    test("renders loop name", () => {
      const loop = createLoop({ config: { name: "My Test Loop" } });
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("My Test Loop")).toBeInTheDocument();
    });

    test("renders status badge", () => {
      const loop = createLoopWithStatus("running");
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Running")).toBeInTheDocument();
    });
  });

  describe("status-specific rendering", () => {
    test("idle loop shows Idle badge", () => {
      const loop = createLoopWithStatus("idle");
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Idle")).toBeInTheDocument();
    });

    test("planning loop shows Planning badge", () => {
      const loop = createLoopWithStatus("planning");
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Planning")).toBeInTheDocument();
    });

    test("completed loop shows Completed badge", () => {
      const loop = createLoopWithStatus("completed");
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Completed")).toBeInTheDocument();
    });

    test("failed loop shows Failed badge", () => {
      const loop = createLoopWithStatus("failed");
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Failed")).toBeInTheDocument();
    });

    test("merged loop shows Merged badge", () => {
      const loop = createLoopWithStatus("merged");
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Merged")).toBeInTheDocument();
    });

    test("pushed loop shows Pushed badge", () => {
      const loop = createLoopWithStatus("pushed");
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Pushed")).toBeInTheDocument();
    });

    test("deleted loop shows Deleted badge", () => {
      const loop = createLoopWithStatus("deleted");
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Deleted")).toBeInTheDocument();
    });
  });

  describe("stats section", () => {
    test("shows iterations for non-draft loops", () => {
      const loop = createLoopWithStatus("running", {
        state: { currentIteration: 5 },
        config: { maxIterations: 10 },
      });
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Iterations:")).toBeInTheDocument();
      expect(getByText("5/10")).toBeInTheDocument();
    });

    test("shows iterations with Infinity when maxIterations is Infinity", () => {
      const loop = createLoopWithStatus("running", {
        state: { currentIteration: 3 },
        config: { maxIterations: Infinity },
      });
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      // Infinity is truthy so it renders as "3/Infinity"
      expect(getByText("3/Infinity")).toBeInTheDocument();
    });

    test("shows last activity text", () => {
      const loop = createLoopWithStatus("running");
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Last activity:")).toBeInTheDocument();
    });

    test("hides stats for draft loops", () => {
      const loop = createLoopWithStatus("draft" as any);
      const { queryByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(queryByText("Iterations:")).not.toBeInTheDocument();
      expect(queryByText("Last activity:")).not.toBeInTheDocument();
    });

    test("renders stats after the error and git sections", () => {
      const loop = createLoopWithStatus("failed", {
        state: {
          error: createLoopError({ message: "Still failed" }),
          git: createGitState({ workingBranch: "feature-x-a1b2c3d" }),
        },
      });
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);

      const errorMessage = getByText("Still failed");
      const branchLabel = getByText("Branch:");
      const iterationsLabel = getByText("Iterations:");

      expect(errorMessage.compareDocumentPosition(iterationsLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
      expect(branchLabel.compareDocumentPosition(iterationsLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    });

  });

  describe("error display", () => {
    test("shows error message for failed loops", () => {
      const loop = createLoopWithStatus("failed", {
        state: { error: createLoopError({ message: "Out of memory" }) },
      });
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Out of memory")).toBeInTheDocument();
    });

  });

  describe("git info", () => {
    test("shows working branch for non-draft loops with git state", () => {
      const loop = createLoopWithStatus("running", {
        state: {
          git: createGitState({ workingBranch: "feature-x-a1b2c3d" }),
        },
      });
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Branch:")).toBeInTheDocument();
      expect(getByText("feature-x-a1b2c3d")).toBeInTheDocument();
    });

    test("shows commit count when commits exist", () => {
      const loop = createLoopWithStatus("completed", {
        state: {
          git: createGitState({
            workingBranch: "test-a1b2c3d",
            commits: [createGitCommit(), createGitCommit(), createGitCommit()],
          }),
        },
      });
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("(3 commits)")).toBeInTheDocument();
    });

    test("hides commit count when no commits", () => {
      const loop = createLoopWithStatus("completed", {
        state: {
          git: createGitState({ commits: [] }),
        },
      });
      const { queryByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(queryByText(/commits\)/)).not.toBeInTheDocument();
    });

    test("hides git info for draft loops", () => {
      const loop = createLoopWithStatus("draft" as any, {
        state: {
          git: createGitState({ workingBranch: "draft-branch-a1b2c3d" }),
        },
      });
      const { queryByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(queryByText("Branch:")).not.toBeInTheDocument();
    });
  });

  describe("review mode", () => {
    test("shows Addressable badge when loop is addressable", () => {
      const loop = createLoopWithStatus("pushed", {
        state: {
          reviewMode: {
            addressable: true,
            completionAction: "push",
            reviewCycles: 1,
            reviewBranches: [],
          },
        },
      });
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Addressable")).toBeInTheDocument();
    });

    test("does not show Addressable badge when not addressable", () => {
      const loop = createLoopWithStatus("completed");
      const { queryByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(queryByText("Addressable")).not.toBeInTheDocument();
    });

    test("shows review cycle number when > 0", () => {
      const loop = createLoopWithStatus("pushed", {
        state: {
          reviewMode: {
            addressable: true,
            completionAction: "push",
            reviewCycles: 3,
            reviewBranches: [],
          },
        },
      });
      const { getByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(getByText("Review Cycle: 3")).toBeInTheDocument();
    });

    test("does not show review cycle when cycles is 0", () => {
      const loop = createLoopWithStatus("pushed", {
        state: {
          reviewMode: {
            addressable: true,
            completionAction: "push",
            reviewCycles: 0,
            reviewBranches: [],
          },
        },
      });
      const { queryByText } = renderWithUser(<LoopCard loop={loop} />);
      expect(queryByText(/Review Cycle/)).not.toBeInTheDocument();
    });
  });

  describe("action buttons - draft", () => {
    test("draft loop does not show Edit button (actions moved to detail view)", () => {
      const loop = createLoopWithStatus("draft" as any);
      const { queryByRole } = renderWithUser(<LoopCard loop={loop} />);
      expect(queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    });

    test("draft loop card invokes onClick when clicked", async () => {
      const loop = createLoopWithStatus("draft" as any, {
        config: { name: "Draft Loop" },
      });
      const onClick = mock();
      const { getByText, user } = renderWithUser(
        <LoopCard loop={loop} onClick={onClick} />
      );
      await user.click(getByText("Draft Loop"));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe("no action buttons on dashboard cards", () => {
    test("completed loop does not show Accept button", () => {
      const loop = createLoopWithStatus("completed", {
        state: { git: createGitState() },
      });
      const { queryByRole } = renderWithUser(<LoopCard loop={loop} />);
      expect(queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    });

    test("completed loop does not show Delete button", () => {
      const loop = createLoopWithStatus("completed");
      const { queryByRole } = renderWithUser(<LoopCard loop={loop} />);
      expect(queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    });

    test("merged loop does not show Purge button", () => {
      const loop = createLoopWithStatus("merged");
      const { queryByRole } = renderWithUser(<LoopCard loop={loop} />);
      expect(queryByRole("button", { name: "Purge" })).not.toBeInTheDocument();
    });

    test("planning loop does not show Review Plan button", () => {
      const loop = createLoopWithStatus("planning");
      const { queryByRole } = renderWithUser(<LoopCard loop={loop} />);
      expect(queryByRole("button", { name: "Review Plan" })).not.toBeInTheDocument();
    });

    test("addressable pushed loop does not show Address Comments button", () => {
      const loop = createLoopWithStatus("pushed", {
        state: {
          reviewMode: {
            addressable: true,
            completionAction: "push",
            reviewCycles: 1,
            reviewBranches: [],
          },
        },
      });
      const { queryByRole } = renderWithUser(<LoopCard loop={loop} />);
      expect(queryByRole("button", { name: "Address Comments" })).not.toBeInTheDocument();
    });
  });

  describe("rename button", () => {
    test("shows rename button when onRename provided", () => {
      const loop = createLoop();
      const { getByLabelText } = renderWithUser(
        <LoopCard loop={loop} onRename={mock()} />
      );
      expect(getByLabelText("Rename loop")).toBeInTheDocument();
    });

    test("hides rename button when onRename not provided", () => {
      const loop = createLoop();
      const { queryByLabelText } = renderWithUser(<LoopCard loop={loop} />);
      expect(queryByLabelText("Rename loop")).not.toBeInTheDocument();
    });

    test("rename button calls onRename", async () => {
      const loop = createLoop();
      const onRename = mock();
      const { getByLabelText, user } = renderWithUser(
        <LoopCard loop={loop} onRename={onRename} />
      );
      await user.click(getByLabelText("Rename loop"));
      expect(onRename).toHaveBeenCalled();
    });
  });

  describe("card click", () => {
    test("clicking card invokes onClick handler", async () => {
      const loop = createLoop({ config: { name: "Clickable Loop" } });
      const onClick = mock();
      const { getByText, user } = renderWithUser(
        <LoopCard loop={loop} onClick={onClick} />
      );
      await user.click(getByText("Clickable Loop"));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

  });
});
