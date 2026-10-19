/**
 * Publish a confirmed stable GitHub release from the remote default branch.
 */

type Version = [bigint, bigint, bigint];
type Bump = "major" | "minor" | "patch";

const repositoryDirectory = `${import.meta.dir}/..`;
const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function github(args: string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], {
    cwd: repositoryDirectory,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout.trim();
}

function parseVersion(tag: string): Version | null {
  const match = stableTagPattern.exec(tag);
  return match ? [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)] : null;
}

function isNewer(candidate: Version, current: Version): boolean {
  for (const index of [0, 1, 2] as const) {
    if (candidate[index] !== current[index]) {
      return candidate[index] > current[index];
    }
  }
  return false;
}

async function latestVersion(repository: string): Promise<Version> {
  const tags = await github([
    "api",
    `repos/${repository}/releases?per_page=100`,
    "--paginate",
    "--jq",
    ".[] | select(.draft == false and .prerelease == false) | .tag_name",
  ]);
  let latest: Version | null = null;
  for (const tag of tags.split("\n")) {
    const version = parseVersion(tag);
    if (version && (!latest || isNewer(version, latest))) {
      latest = version;
    }
  }
  if (!latest) {
    throw new Error("No published stable vX.Y.Z release found; cannot determine a bump baseline.");
  }
  return latest;
}

function formatVersion(version: Version): string {
  return `v${version.join(".")}`;
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
  console.log(`\nTag and title: ${tag}`);
  console.log(`Source: ${branch} (${commit})`);
  console.log("Description: GitHub-generated release notes.");
  console.log("Publishing triggers the binary and Docker release workflows.");
  const confirmation = prompt(`Publish ${tag}? Type yes to confirm:`);
  if (confirmation?.trim().toLowerCase() !== "yes") {
    console.log("Release cancelled.");
    return;
  }

  const existingTag = await github([
    "api",
    `repos/${repository}/git/matching-refs/tags/${tag}`,
    "--jq",
    `.[] | select(.ref == "refs/tags/${tag}") | .ref`,
  ]);
  if (existingTag) {
    throw new Error(`Tag ${tag} already exists remotely; refusing to release an existing tag.`);
  }

  const url = await github([
    "release", "create", tag,
    "--repo", repository,
    "--target", commit,
    "--title", tag,
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
