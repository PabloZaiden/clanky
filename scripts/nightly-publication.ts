import { appendFile } from "node:fs/promises";
import { github } from "./release-version";

const [workflow, ...extra] = process.argv.slice(2);
if (!workflow || !/^[A-Za-z0-9_-]+\.ya?ml$/.test(workflow) || extra.length) {
  throw new Error("Usage: bun scripts/nightly-publication.ts workflow-file");
}
const {
  GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: revision,
  GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_OUTPUT: output,
} = process.env;
if ((event !== "schedule" && event !== "workflow_dispatch") || ref !== "refs/heads/main"
  || !revision || !/^[a-f0-9]{40}$/.test(revision)
  || !repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  || !runId || !/^[1-9]\d*$/.test(runId) || !output) {
  throw new Error("Main publication requires a scheduled/manual run on main with valid GitHub context.");
}
const head = await github([
  "api", `repos/${repository}/git/ref/heads/main`, "--jq", ".object.sha",
]);
if (head !== revision) {
  throw new Error("Main changed before publication started; start a new run from current main.");
}

let publish = true;
if (event === "schedule") {
  const history = await github([
    "api",
    `repos/${repository}/actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=100`,
    "--paginate",
    "--jq",
    '.workflow_runs[] | select(.event == "schedule" or .event == "workflow_dispatch") | [.id, .head_sha, .updated_at, .conclusion] | @tsv',
  ]);
  const runs = history.split("\n").filter(Boolean).map(line => {
    const [id, sha, updated, conclusion, ...extra] = line.split("\t");
    const completed = Date.parse(updated ?? "");
    if (!id || !/^[1-9]\d*$/.test(id) || !sha || !/^[a-f0-9]{40}$/.test(sha)
      || !Number.isFinite(completed) || !conclusion || !/^[a-z_]+$/.test(conclusion) || extra.length) {
      throw new Error("GitHub returned invalid completed publication history.");
    }
    return { id, revision: sha, completed, conclusion };
  }).filter(run => run.id !== runId).sort((left, right) => right.completed - left.completed);
  const previous = runs[0];
  publish = !previous || previous.conclusion !== "success" || previous.revision !== revision;
  console.log(previous
    ? `Last completed main publication: ${previous.revision} (run ${previous.id}, ${previous.conclusion}).`
    : "No completed nightly/manual main publication exists yet.");
}
console.log(publish
  ? `Publishing main ${revision}${event === "workflow_dispatch" ? " (manual generation forced)" : ""}.`
  : `Skipping unchanged main ${revision}.`);
await appendFile(output, `publish=${publish}\n`);
