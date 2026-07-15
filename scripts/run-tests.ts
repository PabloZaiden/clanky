interface SuiteDefinition {
  id: string;
  label: string;
  pattern: string;
  fileConcurrency: number;
  argsPrefix: string[];
  modes: Array<"all" | "backend" | "frontend">;
}

export interface TestBucket {
  id: string;
  label: string;
  args: string[];
}

interface TestResult {
  bucket: TestBucket;
  exitCode: number;
  output: string;
  elapsedMs: number;
}

export interface ShardAssignment {
  files: string[];
}

interface RunTestBucketsDependencies {
  buildBuckets: (
    mode: "all" | "backend" | "frontend",
    workerCapacity: number,
  ) => Promise<TestBucket[]>;
  runBucket: (bucket: TestBucket, env: Record<string, string>) => Promise<TestResult>;
  log: (message: string) => void;
}

const rootDir = `${import.meta.dir}/..`;
const defaultMaxWorkers = 10;

const suiteDefinitions: SuiteDefinition[] = [
  {
    id: "unit",
    label: "tests/unit",
    pattern: "tests/unit/**/*.test.{ts,tsx,js,jsx}",
    fileConcurrency: 2,
    argsPrefix: ["test", "--dots", "--timeout", "30000", "--preload", "./tests/backend-user-context.ts"],
    modes: ["all", "backend"],
  },
  {
    id: "api",
    label: "tests/api",
    pattern: "tests/api/**/*.test.{ts,tsx,js,jsx}",
    fileConcurrency: 2,
    argsPrefix: ["test", "--dots", "--timeout", "30000", "--preload", "./tests/backend-user-context.ts"],
    modes: ["all", "backend"],
  },
  {
    id: "e2e",
    label: "tests/e2e",
    pattern: "tests/e2e/**/*.test.{ts,tsx,js,jsx}",
    fileConcurrency: 1,
    argsPrefix: ["test", "--dots", "--timeout", "30000", "--preload", "./tests/backend-user-context.ts"],
    modes: ["all", "backend"],
  },
  {
    id: "integration",
    label: "tests/integration",
    pattern: "tests/integration/**/*.test.{ts,tsx,js,jsx}",
    fileConcurrency: 1,
    argsPrefix: ["test", "--dots", "--timeout", "30000", "--preload", "./tests/backend-user-context.ts"],
    modes: ["all", "backend"],
  },
  {
    id: "frontend-root",
    label: "tests/frontend/root",
    pattern: "tests/frontend/*.test.{ts,tsx,js,jsx}",
    fileConcurrency: 1,
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
    fileConcurrency: 1,
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
    fileConcurrency: 1,
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
    fileConcurrency: 1,
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

export function buildEnv(sourceEnv: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (env["CLANKY_LOG_LEVEL"] === undefined) {
    env["CLANKY_LOG_LEVEL"] = "fatal";
  }
  env["CLANKY_TEST_OWNER_CONTEXT"] = "1";
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

function formatFullOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed : "(no output)";
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

export function resolveMaxWorkers(sourceEnv: Record<string, string | undefined>): number {
  const parsedWorkerCount = Number.parseInt(sourceEnv["CLANKY_TEST_MAX_WORKERS"] ?? "", 10);
  if (Number.isNaN(parsedWorkerCount) || parsedWorkerCount === 0) {
    return defaultMaxWorkers;
  }
  return Math.max(1, parsedWorkerCount);
}

export function shouldRetryFailedBuckets(env: Record<string, string>): boolean {
  if (env["CLANKY_TEST_RETRY_FAILED_BUCKETS"] === "0") {
    return false;
  }
  if (env["CLANKY_TEST_RETRY_FAILED_BUCKETS"] === "1") {
    return true;
  }
  return env["CI"] === "true";
}

export function withMaxConcurrency(args: string[], concurrency: number): string[] {
  const maxConcurrencyIndex = args.indexOf("--max-concurrency");
  if (maxConcurrencyIndex === -1 || args[maxConcurrencyIndex + 1] === undefined) {
    return [...args];
  }

  const nextArgs = [...args];
  nextArgs[maxConcurrencyIndex + 1] = String(concurrency);
  return nextArgs;
}

export function createRetryBucket(bucket: TestBucket): TestBucket {
  return {
    ...bucket,
    args: withMaxConcurrency(bucket.args, 1),
  };
}

export function formatBucketHeader(initialResult: TestResult, retryResult?: TestResult): string {
  if (initialResult.exitCode === 0) {
    return `== ${initialResult.bucket.label} PASS (${formatDuration(initialResult.elapsedMs)}) ==`;
  }
  if (retryResult === undefined) {
    return `== ${initialResult.bucket.label} FAIL (${formatDuration(initialResult.elapsedMs)}) ==`;
  }
  if (retryResult.exitCode === 0) {
    return [
      `== ${initialResult.bucket.label} PASS after retry `,
      `(${formatDuration(retryResult.elapsedMs)} retry, ${formatDuration(initialResult.elapsedMs)} initial fail) ==`,
    ].join("");
  }
  return [
    `== ${initialResult.bucket.label} FAIL after retry `,
    `(${formatDuration(retryResult.elapsedMs)} retry, ${formatDuration(initialResult.elapsedMs)} initial fail) ==`,
  ].join("");
}

export function formatBucketOutput(initialResult: TestResult, retryResult?: TestResult): string | null {
  if (initialResult.exitCode === 0) {
    return null;
  }
  if (retryResult !== undefined && retryResult.exitCode === 0) {
    return null;
  }
  if (retryResult === undefined) {
    return formatFullOutput(initialResult.output);
  }

  const initialOutput = formatFullOutput(initialResult.output);
  const retryOutput = formatFullOutput(retryResult.output);
  return [
    "Initial attempt output:",
    initialOutput,
    "",
    retryOutput === initialOutput ? "Retry output (matched initial attempt):" : "Retry output:",
    retryOutput,
  ].join("\n");
}

function formatCompletionSummary(elapsedMs: number, retriedBucketCount: number): string {
  const retrySuffix = retriedBucketCount > 0
    ? ` after retrying ${retriedBucketCount} failed bucket(s)`
    : "";
  return `Test run completed in ${formatDuration(elapsedMs)}${retrySuffix}.`;
}

export function partitionFiles(files: string[], workerCapacity: number): ShardAssignment[] {
  if (files.length === 0) {
    return [];
  }

  const normalizedWorkerCapacity = Number.isFinite(workerCapacity)
    ? Math.trunc(workerCapacity)
    : 1;
  const bucketCount = Math.max(1, Math.min(files.length, normalizedWorkerCapacity));
  const shards: ShardAssignment[] = Array.from({ length: bucketCount }, () => ({
    files: [],
  }));

  for (const [index, file] of files.entries()) {
    shards[index % bucketCount]?.files.push(file);
  }
  return shards;
}

export async function buildBuckets(
  mode: "all" | "backend" | "frontend",
  workerCapacity: number = defaultMaxWorkers,
): Promise<TestBucket[]> {
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

    const shards = partitionFiles(files, workerCapacity);
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
      });
    }
  }

  return buckets;
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
  runBucketImpl: (bucket: TestBucket, env: Record<string, string>) => Promise<TestResult> = runBucket,
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
      results.push(await runBucketImpl(bucket, env));
    }
  });

  await Promise.all(workers);
  return results;
}

function isFrontendBucket(bucket: TestBucket): boolean {
  return bucket.id.startsWith("frontend-");
}

async function runInitialBuckets(
  buckets: TestBucket[],
  env: Record<string, string>,
  maxWorkers: number,
  runBucketImpl: (bucket: TestBucket, env: Record<string, string>) => Promise<TestResult>,
): Promise<TestResult[]> {
  const frontendBuckets = buckets.filter(isFrontendBucket);
  const otherBuckets = buckets.filter((bucket) => !isFrontendBucket(bucket));
  const results = await runBuckets(otherBuckets, env, maxWorkers, runBucketImpl);

  // Frontend test buckets share happy-dom browser globals and must not overlap.
  results.push(...await runBuckets(frontendBuckets, env, 1, runBucketImpl));
  return results;
}

export async function runTestBuckets(
  modeArg: string | undefined,
  sourceEnv: Record<string, string | undefined> = process.env,
  dependencies: Partial<RunTestBucketsDependencies> = {},
): Promise<number> {
  const mode = assertValidMode(modeArg);
  const env = buildEnv(sourceEnv);
  const startedAt = Date.now();
  const buildBucketsImpl = dependencies.buildBuckets ?? buildBuckets;
  const runBucketImpl = dependencies.runBucket ?? runBucket;
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const configuredMaxWorkers = resolveMaxWorkers(env);
  const buckets = await buildBucketsImpl(mode, configuredMaxWorkers);
  const maxWorkers = Math.max(1, Math.min(configuredMaxWorkers, buckets.length));

  log(`Running ${buckets.length} test bucket(s) in parallel...`);
  log(`Using up to ${maxWorkers} worker process(es).`);
  for (const bucket of buckets) {
    log(`- ${bucket.label}`);
  }
  log("");

  const initialResults = await runInitialBuckets(buckets, env, maxWorkers, runBucketImpl);
  const failedResults = initialResults.filter((result) => result.exitCode !== 0);
  const retryResults = new Map<string, TestResult>();

  if (failedResults.length > 0 && shouldRetryFailedBuckets(env)) {
    log(
      `Retrying ${failedResults.length} failed bucket(s) serially with --max-concurrency 1 for transient CI failures...`,
    );
    log("");
    for (const failedResult of failedResults) {
      const retryResult = await runBucketImpl(createRetryBucket(failedResult.bucket), env);
      retryResults.set(failedResult.bucket.id, retryResult);
    }
  }

  let failed = false;
  for (const result of initialResults) {
    const retryResult = retryResults.get(result.bucket.id);
    const finalExitCode = retryResult?.exitCode ?? result.exitCode;
    if (finalExitCode !== 0) {
      failed = true;
    }

    log(formatBucketHeader(result, retryResult));
    const output = formatBucketOutput(result, retryResult);
    if (output !== null) {
      log(output);
    }
    log("");
  }

  log(formatCompletionSummary(Date.now() - startedAt, retryResults.size));
  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exit(await runTestBuckets(process.argv[2]));
}
