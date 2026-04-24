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
  test("buildFallbackPullRequestMetadata summarizes commits and files in a neutral fallback format", () => {
    const metadata = buildFallbackPullRequestMetadata(metadataInput);

    expect(metadata.title).toBe("Generate PR metadata from actual changes and cover PR metadata fallback behavior");
    expect(metadata.body).toContain("## Summary");
    expect(metadata.body).toContain("## Changes");
    expect(metadata.body).toContain("src/core/automatic-pr-flow-github.ts");
    expect(metadata.body).toContain("## Branches");
  });

  test("buildFallbackPullRequestMetadata strips banned branding and automation wording while keeping fallback sections useful", () => {
    const metadata = buildFallbackPullRequestMetadata({
      ...metadataInput,
      commitMessages: [
        "feat(pr): improve Ralpher pull request summary generation",
        "test(pr): remove generated automatically AutoPR wording from metadata",
      ],
    });

    expect(metadata.title).toBe("Improve pull request summary generation and remove wording from metadata");
    expect(metadata.title).not.toMatch(/ralpher|autopr|generated automatically/i);
    expect(metadata.body).toContain("## Summary");
    expect(metadata.body).toContain("- Improve pull request summary generation");
    expect(metadata.body).toContain("- Remove wording from metadata");
    expect(metadata.body).toContain("## Changes");
    expect(metadata.body).toContain("## Files");
    expect(metadata.body).toContain("## Branches");
    expect(metadata.body).not.toMatch(/ralpher|autopr|generated automatically/i);
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
