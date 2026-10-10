/**
 * Deterministic GitHub CLI boundary for automatic pull request E2E coverage.
 */

interface GitHubFixtureState {
  autoMerge: boolean;
  branch: string;
  created: boolean;
  resolved: boolean;
}

const args = process.argv.slice(2);
const statePath = process.env["CLANKY_E2E_GH_STATE_FILE"];

if (!statePath) {
  process.stderr.write("CLANKY_E2E_GH_STATE_FILE is required\n");
  process.exit(2);
}

async function readState(): Promise<GitHubFixtureState> {
  const file = Bun.file(statePath!);
  if (!await file.exists()) {
    return {
      autoMerge: false,
      branch: "",
      created: false,
      resolved: false,
    };
  }
  return await file.json() as GitHubFixtureState;
}

async function writeState(state: GitHubFixtureState): Promise<void> {
  await Bun.write(statePath!, `${JSON.stringify(state)}\n`);
}

function argumentAfter(name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? "") : "";
}

function pullRequestView(state: GitHubFixtureState): Record<string, unknown> {
  const mergedAt = state.resolved ? "2026-01-02T03:04:05.000Z" : null;
  return {
    number: 42,
    url: "https://github.com/e2e/clanky-fixture/pull/42",
    state: state.resolved ? "MERGED" : "OPEN",
    mergedAt,
    reviewDecision: state.resolved ? "APPROVED" : "CHANGES_REQUESTED",
    mergeStateStatus: "CLEAN",
  };
}

function pullRequestDetails(state: GitHubFixtureState): Record<string, unknown> {
  const view = pullRequestView(state);
  return {
    data: {
      repository: {
        pullRequest: {
          ...view,
          viewerCanUpdateBranch: false,
          headRefOid: "1234567890abcdef1234567890abcdef12345678",
          commits: {
            nodes: [{
              commit: {
                oid: "1234567890abcdef1234567890abcdef12345678",
                statusCheckRollup: {
                  contexts: {
                    nodes: [],
                  },
                },
              },
            }],
          },
          reviewThreads: {
            nodes: state.resolved
              ? []
              : [{
                  id: "e2e-review-thread",
                  isResolved: false,
                  isOutdated: false,
                  isCollapsed: false,
                  comments: {
                    nodes: [{
                      id: "e2e-review-comment",
                      body: "Document the externally observable autonomous change.",
                      createdAt: "2026-01-01T00:00:00.000Z",
                      url: "https://github.com/e2e/clanky-fixture/pull/42#discussion_r1",
                      author: { login: "e2e-reviewer" },
                      path: "e2e-autonomous-change.txt",
                      originalLine: 1,
                    }],
                  },
                }],
          },
          comments: { nodes: [] },
          reviews: { nodes: [] },
        },
      },
    },
  };
}

if (args[0] === "--version") {
  process.stdout.write("gh version 2.99.0 (Clanky E2E fixture)\n");
} else if (args[0] === "pr" && args[1] === "view") {
  const state = await readState();
  if (!state.created) {
    process.stderr.write("no pull requests found for branch\n");
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(pullRequestView(state))}\n`);
} else if (args[0] === "pr" && args[1] === "create") {
  const state = await readState();
  state.created = true;
  state.branch = argumentAfter("--head");
  await writeState(state);
  process.stdout.write("https://github.com/e2e/clanky-fixture/pull/42\n");
} else if (args[0] === "pr" && args[1] === "merge") {
  const state = await readState();
  if (!state.created) {
    process.stderr.write("pull request not found\n");
    process.exit(1);
  }
  state.autoMerge = true;
  await writeState(state);
  process.stdout.write("Auto-merge enabled\n");
} else if (args[0] === "api" && args[1] === "graphql") {
  const state = await readState();
  const query = argumentAfter("-f");
  if (query.includes("resolveReviewThread")) {
    state.resolved = true;
    await writeState(state);
    process.stdout.write(JSON.stringify({
      data: {
        resolveReviewThread: {
          thread: {
            id: "e2e-review-thread",
            isResolved: true,
          },
        },
      },
    }));
  } else {
    process.stdout.write(`${JSON.stringify(pullRequestDetails(state))}\n`);
  }
} else {
  process.stderr.write(`Unsupported gh fixture command: ${args.join(" ")}\n`);
  process.exit(2);
}
