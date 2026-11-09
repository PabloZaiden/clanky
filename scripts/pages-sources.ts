import { formatVersion, github, latestVersion } from "./release-version";

const [latestRevision, ...extra] = process.argv.slice(2);
if (extra.length || (latestRevision !== undefined && !/^[a-f0-9]{40}$/.test(latestRevision))) {
  throw new Error("Usage: bun scripts/pages-sources.ts [latest-source-revision]");
}
const repository = process.env["GITHUB_REPOSITORY"] ?? await github([
  "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner",
]);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error("Pages publishing requires a valid GitHub repository.");
}
const version = await latestVersion(repository);
const tag = formatVersion(version);
const [stable, latest] = await Promise.all([
  github(["api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"]),
  latestRevision ?? github(["api", `repos/${repository}/git/ref/heads/main`, "--jq", ".object.sha"]),
]);
if (![stable, latest].every(revision => /^[a-f0-9]{40}$/.test(revision))) {
  throw new Error("Pages publishing requires full stable and latest source revisions.");
}
console.log(JSON.stringify({
  stable: { revision: stable, tag, version: version.join(".") },
  latest: { revision: latest },
}));
