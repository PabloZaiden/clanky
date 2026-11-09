export type Version = [bigint, bigint, bigint];

const repositoryDirectory = `${import.meta.dir}/..`;
const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export async function github(args: string[]): Promise<string> {
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

export async function latestVersion(repository: string): Promise<Version> {
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

export function formatVersion(version: Version): string {
  return `v${version.join(".")}`;
}
