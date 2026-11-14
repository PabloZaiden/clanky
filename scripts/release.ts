/**
 * Publish a confirmed stable GitHub release from the remote default branch.
 */

import { formatVersion, github, latestVersion, type Version } from "./release-version";
import { appStoreWhatsNewSchema, formatAppStoreReleaseNotes } from "./app-store-release-notes";
import { z } from "zod";

type Bump = "major" | "minor" | "patch";

const mainPublicationWorkflow = "binary-release.yml";
const publicationRunSchema = z.object({
  id: z.number().int().positive(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  head_branch: z.string().min(1),
  event: z.enum(["schedule", "workflow_dispatch"]),
  status: z.enum(["queued", "requested", "waiting", "pending", "in_progress", "completed"]),
  conclusion: z.string().nullable(),
  updated_at: z.iso.datetime(),
});

async function assertCurrentMain(repository: string, branch: string, commit: string): Promise<void> {
  const head = await github([
    "api", `repos/${repository}/commits/${encodeURIComponent(branch)}`, "--jq", ".sha",
  ]);
  if (head !== commit) {
    throw new Error("Main changed after the release preview; run bun run release again to confirm the new commit.");
  }
}

async function assertTagAvailable(repository: string, tag: string): Promise<void> {
  const existingTag = await github([
    "api",
    `repos/${repository}/git/matching-refs/tags/${tag}`,
    "--jq",
    `.[] | select(.ref == "refs/tags/${tag}") | .ref`,
  ]);
  if (existingTag) {
    throw new Error(`Tag ${tag} already exists remotely; refusing to release an existing tag.`);
  }
}

async function ensureMainPublication(repository: string, branch: string, commit: string): Promise<void> {
  await assertCurrentMain(repository, branch, commit);
  console.log(`Checking complete main publication for ${commit}...`);
  const history = await github([
    "api",
    `repos/${repository}/actions/workflows/${mainPublicationWorkflow}/runs?branch=${encodeURIComponent(branch)}&head_sha=${commit}&per_page=100`,
    "--paginate",
    "--jq",
    '.workflow_runs[] | select(.event == "schedule" or .event == "workflow_dispatch") | @json',
  ]);
  const runs = history.split("\n").filter(Boolean)
    .map(line => publicationRunSchema.parse(JSON.parse(line)))
    .filter(run => run.head_sha === commit && run.head_branch === branch)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at) || right.id - left.id);
  const previous = runs.find(run => run.status !== "completed") ?? runs[0];
  if (previous?.status === "completed" && previous.conclusion === "success") {
    console.log(`Complete main publication already succeeded: https://github.com/${repository}/actions/runs/${previous.id}`);
    return;
  }

  let runId: number;
  if (previous && previous.status !== "completed") {
    runId = previous.id;
  } else {
    await assertCurrentMain(repository, branch, commit);
    console.log("Starting complete main publication (binaries, Docker, Apple apps, and Pages)...");
    const dispatch = z.object({ workflow_run_id: z.number().int().positive() }).parse(JSON.parse(await github([
      "api", `repos/${repository}/actions/workflows/${mainPublicationWorkflow}/dispatches`,
      "--method", "POST",
      "--header", "X-GitHub-Api-Version: 2026-03-10",
      "--raw-field", `ref=${branch}`,
    ])));
    runId = dispatch.workflow_run_id;
  }

  const readRun = async () => publicationRunSchema.parse(JSON.parse(await github([
    "api", `repos/${repository}/actions/runs/${runId}`,
  ])));
  const selected = await readRun();
  if (selected.id !== runId || selected.head_sha !== commit || selected.head_branch !== branch) {
    throw new Error(`Main publication run ${runId} does not match the confirmed commit; no release was created.`);
  }
  console.log(`Waiting for complete main publication: https://github.com/${repository}/actions/runs/${runId}`);
  await github(["run", "watch", String(runId), "--repo", repository, "--exit-status", "--interval", "10"]);
  const completed = await readRun();
  if (completed.id !== runId || completed.head_sha !== commit || completed.head_branch !== branch
    || completed.status !== "completed" || completed.conclusion !== "success") {
    throw new Error(`Main publication run ${runId} did not complete successfully (${completed.status}/${completed.conclusion}); no release was created.`);
  }
  console.log("Complete main publication succeeded.");
}

function bumpVersion(version: Version, bump: Bump): Version {
  const [major, minor, patch] = version;
  switch (bump) {
    case "major":
      return [major + 1n, 0n, 0n];
    case "minor":
      return [major, minor + 1n, 0n];
    case "patch":
      return [major, minor, patch + 1n];
  }
}

function chooseBump(): Bump | null {
  while (true) {
    const answer = prompt("Version bump (major/minor/patch, Enter to cancel):");
    if (answer === null || answer.trim() === "") {
      return null;
    }
    const bump = answer.trim().toLowerCase();
    if (bump === "major" || bump === "minor" || bump === "patch") {
      return bump;
    }
    console.error("Choose major, minor, or patch.");
  }
}

function chooseWhatsNew(): string | null {
  while (true) {
    const answer = prompt("App Store What's New (English, 1-4000 characters; Enter to cancel):");
    if (answer === null || answer.trim() === "") return null;
    const result = appStoreWhatsNewSchema.safeParse(answer);
    if (result.success) return result.data;
    console.error(result.error.issues.map(issue => issue.message).join("\n"));
  }
}

async function release(): Promise<void> {
  if (Bun.argv.length > 2) {
    throw new Error("Usage: bun run release (interactive; no arguments).");
  }
  if (!Bun.which("gh")) {
    throw new Error("GitHub CLI is required. Install gh and authenticate with gh auth login.");
  }

  const [repository, branch, ...extra] = (await github([
    "repo", "view",
    "--json", "nameWithOwner,defaultBranchRef",
    "--jq", ".nameWithOwner, .defaultBranchRef.name",
  ])).split("\n");
  if (!repository || !branch || branch === "null" || extra.length > 0) {
    throw new Error("Could not resolve the GitHub repository and its default branch.");
  }

  const version = await latestVersion(repository);
  const commit = await github([
    "api", `repos/${repository}/commits/${encodeURIComponent(branch)}`, "--jq", ".sha",
  ]);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Could not resolve the remote default branch to a commit SHA.");
  }

  console.log(`Repository: ${repository}`);
  console.log(`Current stable release: ${formatVersion(version)}`);
  const bump = chooseBump();
  if (bump === null) {
    console.log("Release cancelled.");
    return;
  }

  const tag = formatVersion(bumpVersion(version, bump));
  const whatsNew = chooseWhatsNew();
  if (whatsNew === null) {
    console.log("Release cancelled.");
    return;
  }
  console.log(`\nTag and title: ${tag}`);
  console.log(`Source: ${branch} (${commit})`);
  console.log(`App Store What's New:\n${whatsNew}`);
  console.log("Description: App Store What's New and GitHub-generated release notes.");
  console.log("Before publishing, require a successful complete main build; wait for one or start it if needed.");
  console.log("Publishing triggers the binary and Docker release workflows.");
  const confirmation = prompt(`Publish ${tag}? Type yes to confirm:`);
  if (confirmation?.trim().toLowerCase() !== "yes") {
    console.log("Release cancelled.");
    return;
  }

  await assertTagAvailable(repository, tag);
  await ensureMainPublication(repository, branch, commit);
  await assertCurrentMain(repository, branch, commit);
  await assertTagAvailable(repository, tag);

  const url = await github([
    "release", "create", tag,
    "--repo", repository,
    "--target", commit,
    "--title", tag,
    "--notes", formatAppStoreReleaseNotes(whatsNew),
    "--generate-notes",
  ]);
  console.log(url);
}

try {
  await release();
} catch (error) {
  console.error(`Release failed: ${String(error)}`);
  process.exitCode = 1;
}
