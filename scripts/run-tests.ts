interface SuiteDefinition {
  id: string;
  label: string;
  pattern: string;
  shardCount: number;
  fileConcurrency: number;
  argsPrefix: string[];
  modes: Array<"all" | "backend" | "frontend">;
}

interface TestBucket {
  id: string;
  label: string;
  args: string[];
  weight: number;
}

interface TestResult {
  bucket: TestBucket;
  exitCode: number;
  output: string;
  elapsedMs: number;
}

interface ShardAssignment {
  files: string[];
  weight: number;
}

const rootDir = `${import.meta.dir}/..`;

const measuredFileWeights: Record<string, number> = {
  "tests/integration/user-scenarios/plan-loop.test.ts": 5,
  "tests/unit/provisioning-manager.test.ts": 5,
  "tests/api/plan-mode.test.ts": 4,
  "tests/unit/plan-mode.test.ts": 4,
  "tests/unit/ssh-server-manager.test.ts": 4,
  "tests/api/provisioning.test.ts": 3,
  "tests/integration/user-scenarios/review-cycles.test.ts": 3,
  "tests/unit/chat-manager.test.ts": 3,
  "tests/unit/git-service.test.ts": 3,
  "tests/unit/loop-engine.test.ts": 3,
  "tests/unit/push-sync.test.ts": 3,
  "tests/unit/review-mode.test.ts": 3,
  "tests/unit/ssh-server-key-manager.test.ts": 3,
  "tests/frontend/components/CreateLoopForm.test.tsx": 3,
  "tests/frontend/components/LoopDetails.test.tsx": 3,
  "tests/frontend/components/SshSessionDetails.test.tsx": 3,
  "tests/frontend/hooks/useLoop.test.ts": 3,
  "tests/frontend/hooks/useLoops.test.ts": 3,
  "tests/api/loops-control.test.ts": 2,
  "tests/api/loops-crud.test.ts": 2,
  "tests/api/loops-pending.test.ts": 2,
  "tests/api/loops-port-forwards.test.ts": 2,
  "tests/api/ssh-server-files.test.ts": 2,
  "tests/api/ssh-servers.test.ts": 2,
  "tests/e2e/git-workflow.test.ts": 2,
  "tests/e2e/worktree-scenarios.test.ts": 2,
  "tests/integration/user-scenarios/regular-loop.test.ts": 2,
  "tests/unit/update-branch.test.ts": 2,
  "tests/frontend/components/App.test.tsx": 2,
  "tests/frontend/components/ChatDetails.test.tsx": 2,
  "tests/frontend/components/CreateWorkspaceModal.test.tsx": 2,
  "tests/frontend/components/LoopActionBar.test.tsx": 2,
  "tests/frontend/components/WorkspaceFilesView.test.tsx": 2,
  "tests/frontend/scenarios/create-loop.test.tsx": 2,
};

const suiteDefinitions: SuiteDefinition[] = [
  {
    id: "unit",
    label: "tests/unit",
    pattern: "tests/unit/**/*.test.{ts,tsx,js,jsx}",
    shardCount: 6,
    fileConcurrency: 2,
    argsPrefix: ["test", "--dots", "--timeout", "30000"],
    modes: ["all", "backend"],
  },
  {
    id: "api",
    label: "tests/api",
    pattern: "tests/api/**/*.test.{ts,tsx,js,jsx}",
    shardCount: 3,
    fileConcurrency: 2,
    argsPrefix: ["test", "--dots", "--timeout", "30000"],
    modes: ["all", "backend"],
  },
  {
    id: "e2e",
    label: "tests/e2e",
    pattern: "tests/e2e/**/*.test.{ts,tsx,js,jsx}",
    shardCount: 1,
    fileConcurrency: 1,
    argsPrefix: ["test", "--dots", "--timeout", "30000"],
    modes: ["all", "backend"],
  },
  {
    id: "integration",
    label: "tests/integration",
    pattern: "tests/integration/**/*.test.{ts,tsx,js,jsx}",
    shardCount: 2,
    fileConcurrency: 1,
    argsPrefix: ["test", "--dots", "--timeout", "30000"],
    modes: ["all", "backend"],
  },
  {
    id: "frontend-root",
    label: "tests/frontend/root",
    pattern: "tests/frontend/*.test.{ts,tsx,js,jsx}",
    shardCount: 1,
    fileConcurrency: 2,
    argsPrefix: [
      "test",
      "--dots",
      "--timeout",
      "15000",
      "--preload",
      "./tests/frontend/setup.ts",
    ],
    modes: ["all", "frontend"],
  },
  {
    id: "frontend-components",
    label: "tests/frontend/components",
    pattern: "tests/frontend/components/**/*.test.{ts,tsx,js,jsx}",
    shardCount: 4,
    fileConcurrency: 2,
    argsPrefix: [
      "test",
      "--dots",
      "--timeout",
      "15000",
      "--preload",
      "./tests/frontend/setup.ts",
    ],
    modes: ["all", "frontend"],
  },
  {
    id: "frontend-hooks",
    label: "tests/frontend/hooks",
    pattern: "tests/frontend/hooks/**/*.test.{ts,tsx,js,jsx}",
    shardCount: 2,
    fileConcurrency: 2,
    argsPrefix: [
      "test",
      "--dots",
      "--timeout",
      "15000",
      "--preload",
      "./tests/frontend/setup.ts",
    ],
    modes: ["all", "frontend"],
  },
  {
    id: "frontend-scenarios",
    label: "tests/frontend/scenarios",
    pattern: "tests/frontend/scenarios/**/*.test.{ts,tsx,js,jsx}",
    shardCount: 2,
    fileConcurrency: 2,
    argsPrefix: [
      "test",
      "--dots",
      "--timeout",
      "15000",
      "--preload",
      "./tests/frontend/setup.ts",
    ],
    modes: ["all", "frontend"],
  },
];

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (env["RALPHER_LOG_LEVEL"] === undefined) {
    env["RALPHER_LOG_LEVEL"] = "fatal";
  }
  return env;
}

function assertValidMode(mode: string | undefined): "all" | "backend" | "frontend" {
  switch (mode ?? "all") {
    case "all":
      return "all";
    case "backend":
      return "backend";
    case "frontend":
      return "frontend";
    default:
      throw new Error(`Unknown test mode: ${mode ?? ""}`);
  }
}

function formatDuration(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

function summarizeOutput(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return "(no output)";
  }

  return lines.slice(-4).join("\n");
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) {
    return "";
  }
  return await new Response(stream).text();
}

async function listTestFiles(pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const files = await Array.fromAsync(glob.scan({ cwd: rootDir }));
  return files.sort();
}

function getFileWeight(path: string): number {
  return measuredFileWeights[path] ?? 1;
}

function shardFiles(files: string[], shardCount: number): ShardAssignment[] {
  const effectiveShardCount = Math.max(1, Math.min(shardCount, files.length));
  const shards: ShardAssignment[] = Array.from({ length: effectiveShardCount }, () => ({
    files: [],
    weight: 0,
  }));

  const weightedFiles = files
    .map((file) => ({ file, weight: getFileWeight(file) }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));

  for (const weightedFile of weightedFiles) {
    const targetShard = shards.reduce((best, candidate) =>
      candidate.weight < best.weight ? candidate : best,
    );
    targetShard.files.push(weightedFile.file);
    targetShard.weight += weightedFile.weight;
  }

  return shards;
}

async function buildBuckets(mode: "all" | "backend" | "frontend"): Promise<TestBucket[]> {
  const buckets: TestBucket[] = [];

  for (const suite of suiteDefinitions) {
    if (!suite.modes.includes(mode) && mode !== "all") {
      continue;
    }
    if (mode === "all" && !suite.modes.includes("all")) {
      continue;
    }

    const files = await listTestFiles(suite.pattern);
    if (files.length === 0) {
      continue;
    }

    const shards = shardFiles(files, suite.shardCount);
    for (const [index, shard] of shards.entries()) {
      if (shard.files.length === 0) {
        continue;
      }
      const shardLabel = shards.length === 1 ? suite.label : `${suite.label} shard ${index + 1}`;
      buckets.push({
        id: `${suite.id}-${index + 1}`,
        label: shardLabel,
        args: [
          ...suite.argsPrefix,
          "--max-concurrency",
          String(suite.fileConcurrency),
          ...shard.files,
        ],
        weight: shard.weight,
      });
    }
  }

  return buckets.sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
}

async function runBucket(bucket: TestBucket, env: Record<string, string>): Promise<TestResult> {
  const start = Date.now();
  const proc = Bun.spawn({
    cmd: [process.execPath, ...bucket.args],
    cwd: rootDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ]);

  const output = [stdout, stderr].filter((value) => value.length > 0).join("\n");

  return {
    bucket,
    exitCode,
    output,
    elapsedMs: Date.now() - start,
  };
}

async function runBuckets(
  buckets: TestBucket[],
  env: Record<string, string>,
  maxWorkers: number,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  let nextIndex = 0;

  const workerCount = Math.max(1, Math.min(maxWorkers, buckets.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < buckets.length) {
      const bucket = buckets[nextIndex];
      nextIndex += 1;
      if (bucket === undefined) {
        return;
      }
      results.push(await runBucket(bucket, env));
    }
  });

  await Promise.all(workers);
  return results;
}

const mode = assertValidMode(process.argv[2]);
const env = buildEnv();
const startedAt = Date.now();
const buckets = await buildBuckets(mode);
const maxWorkers = Math.max(
  1,
  Number.parseInt(process.env["RALPHER_TEST_MAX_WORKERS"] ?? "", 10)
    || Math.min(10, buckets.length),
);

console.log(`Running ${buckets.length} test bucket(s) in parallel...`);
console.log(`Using up to ${maxWorkers} worker process(es).`);
for (const bucket of buckets) {
  console.log(`- ${bucket.label} (weight ${bucket.weight})`);
}
console.log("");

const results = await runBuckets(buckets, env, maxWorkers);
let failed = false;

for (const result of results) {
  const status = result.exitCode === 0 ? "PASS" : "FAIL";
  if (result.exitCode !== 0) {
    failed = true;
  }

  console.log(`== ${result.bucket.label} ${status} (${formatDuration(result.elapsedMs)}) ==`);
  console.log(result.exitCode === 0 ? summarizeOutput(result.output) : result.output.trim());
  console.log("");
}

console.log(`Parallel test run completed in ${formatDuration(Date.now() - startedAt)}.`);

if (failed) {
  process.exit(1);
}
