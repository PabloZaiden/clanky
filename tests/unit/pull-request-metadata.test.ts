import { expect, test } from "bun:test";
import type { AgentResponse, PromptInput } from "../../src/backends/types";
import {
  buildFallbackPullRequestMetadata,
  generatePullRequestMetadata,
  type PullRequestMetadataBackendInterface,
  type PullRequestMetadataInput,
} from "../../src/core/pull-request-metadata";

const baseMetadata: PullRequestMetadataInput = {
  taskName: "Improve task creation",
  originalPrompt: "Add issue linking to tasks.",
  baseBranch: "main",
  workingBranch: "feature/issue-linking",
  commitMessages: ["feat(tasks): link tasks to GitHub issues"],
  changedFiles: [{
    path: "src/core/task/task-crud.ts",
    status: "modified",
    additions: 12,
    deletions: 2,
  }],
  diffSummary: {
    files: 1,
    insertions: 12,
    deletions: 2,
  },
};

function agentResponse(content: string): AgentResponse {
  return {
    id: "metadata-response",
    content,
    parts: [{ type: "text", text: content }],
  };
}

function backendReturning(content: string, onPrompt?: (prompt: PromptInput) => void): PullRequestMetadataBackendInterface {
  return {
    async sendPrompt(_sessionId, prompt) {
      onPrompt?.(prompt);
      return agentResponse(content);
    },
  };
}

test("adds the linked issue closing directive when generated metadata omits it", async () => {
  let promptText = "";
  const metadata = await generatePullRequestMetadata({
    metadata: { ...baseMetadata, issueNumber: 42 },
    backend: backendReturning(
      JSON.stringify({
        title: "Link tasks to GitHub issues",
        body: "## Summary\n- Stores the linked issue on each task.",
      }),
      (prompt) => {
        promptText = prompt.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
      },
    ),
    sessionId: "metadata-session",
  });

  expect(metadata.body).toContain("Closes #42");
  expect(promptText).toContain("The body MUST include the exact GitHub closing keyword `Closes #42`");
});

test("does not duplicate an existing linked issue closing directive", async () => {
  const metadata = await generatePullRequestMetadata({
    metadata: { ...baseMetadata, issueNumber: 42 },
    backend: backendReturning(JSON.stringify({
      title: "Link tasks to GitHub issues",
      body: "## Summary\n- Stores the linked issue.\n\nCloses #42",
    })),
    sessionId: "metadata-session",
  });

  expect(metadata.body.match(/Closes #42/gi)).toHaveLength(1);
});

test("includes the linked issue closing directive in fallback metadata", () => {
  const metadata = buildFallbackPullRequestMetadata({
    ...baseMetadata,
    issueNumber: 99,
  });

  expect(metadata.body).toContain("Closes #99");
});

test("leaves metadata without a linked issue unchanged", async () => {
  const metadata = await generatePullRequestMetadata({
    metadata: baseMetadata,
    backend: backendReturning(JSON.stringify({
      title: "Link tasks to GitHub issues",
      body: "## Summary\n- Stores task metadata.",
    })),
    sessionId: "metadata-session",
  });

  expect(metadata.body).not.toContain("Closes #");
});
