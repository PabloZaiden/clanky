import { describe, expect, test } from "bun:test";
import { formatToolPathForDisplay } from "@/components/log-viewer/tool-paths";

describe("formatToolPathForDisplay", () => {
  test("preserves a Windows drive root when no display root is provided", () => {
    expect(formatToolPathForDisplay("C:/")).toBe("C:/");
  });

  test("treats a Windows drive root as an absolute prefix", () => {
    expect(formatToolPathForDisplay("C:/workspace/project/src/index.ts", "C:/")).toBe("workspace/project/src/index.ts");
  });

  test("keeps Windows worktree paths relative to their configured root", () => {
    expect(
      formatToolPathForDisplay(
        "C:\\workspace\\project\\.ralph-worktrees\\feature\\src\\persistence\\auth.ts",
        "C:\\workspace\\project\\.ralph-worktrees\\feature",
      ),
    ).toBe("src/persistence/auth.ts");
  });
});
