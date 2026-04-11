import { describe, expect, test } from "bun:test";
import type { AgentResponse, PromptInput } from "../../src/backends/types";
import {
  buildFallbackPullRequestMetadata,
  generatePullRequestMetadata,
  type PullRequestMetadataBackendInterface,
  type PullRequestMetadataInput,
} from "../../src/core/pull-request-metadata";

const metadataInput: PullRequestMetadataInput = {
  loopName: "Automatic PR Flow",
  originalPrompt: "Implement automatic PR title and description generation.",
  baseBranch: "main",
  workingBranch: "feature/automatic-pr-flow",
  commitMessages: [
    "feat(pr): generate PR metadata from actual changes",
    "test(pr): cover PR metadata fallback behavior",
  ],
  changedFiles: [
    {
      path: "src/core/automatic-pr-flow-github.ts",
      status: "modified",
      additions: 12,
      deletions: 4,
    },
    {
      path: "tests/unit/automatic-pr-flow-github.test.ts",
      status: "modified",
      additions: 3,
      deletions: 0,
    },
  ],
  diffSummary: {
    files: 2,
    insertions: 15,
    deletions: 4,
  },
};

class StaticResponseBackend implements PullRequestMetadataBackendInterface {
  constructor(private readonly response: string) {}

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    return {
      id: "response-1",
      content: this.response,
      parts: [{ type: "text", text: this.response }],
    };
  }
}

describe("pull request metadata helpers", () => {
  test("buildFallbackPullRequestMetadata summarizes commits and files without branding", () => {
    const metadata = buildFallbackPullRequestMetadata(metadataInput);

    expect(metadata.title).toBe("Generate PR metadata from actual changes and cover PR metadata fallback behavior");
    expect(metadata.body).toContain("## Summary");
    expect(metadata.body).toContain("src/core/automatic-pr-flow-github.ts");
    expect(metadata.body).not.toContain("Ralpher");
    expect(metadata.body).not.toContain("AutoPR");
  });

  test("buildFallbackPullRequestMetadata strips banned phrases without throwing", () => {
    const metadata = buildFallbackPullRequestMetadata({
      ...metadataInput,
      loopName: "AutoPR",
      baseBranch: "main",
      workingBranch: "feature/generated-automatically",
      commitMessages: [
        "feat(pr): remove AutoPR branding",
        "docs(pr): explain generated automatically output",
      ],
      changedFiles: [],
    });

    expect(metadata.title).toBe("Remove branding and explain output");
    expect(metadata.body).toContain("## Summary");
    expect(metadata.body).not.toContain("AutoPR");
    expect(metadata.body).not.toContain("generated automatically");
  });

  test("generatePullRequestMetadata parses strict JSON responses", async () => {
    const metadata = await generatePullRequestMetadata({
      metadata: metadataInput,
      backend: new StaticResponseBackend(JSON.stringify({
        title: "Generate PR metadata from actual changes",
        body: "## Summary\n- Generate the title and description from completed work.",
      })),
      sessionId: "session-1",
    });

    expect(metadata).toEqual({
      title: "Generate PR metadata from actual changes",
      body: "## Summary\n- Generate the title and description from completed work.",
    });
  });

  test("generatePullRequestMetadata rejects branded metadata", async () => {
    await expect(generatePullRequestMetadata({
      metadata: metadataInput,
      backend: new StaticResponseBackend(JSON.stringify({
        title: "AutoPR by Ralpher",
        body: "Opened by Ralpher.",
      })),
      sessionId: "session-1",
    })).rejects.toThrow("Failed to generate pull request metadata");
  });

  test("generatePullRequestMetadata rejects automation wording", async () => {
    await expect(generatePullRequestMetadata({
      metadata: metadataInput,
      backend: new StaticResponseBackend(JSON.stringify({
        title: "Create the PR automatically",
        body: "## Summary\n- This pull request was generated automatically from the completed work.",
      })),
      sessionId: "session-1",
    })).rejects.toThrow("Failed to generate pull request metadata");
  });
});
