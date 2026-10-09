export type TestMode = "all" | "backend" | "native-worker";

interface SuiteDefinition {
  id: string;
  label: string;
  pattern: string;
  fileConcurrency: number;
  argsPrefix: string[];
  modes: TestMode[];
}

interface SuiteFiles {
  suite: SuiteDefinition;
  files: string[];
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
  outputStreamed?: boolean;
}

type TestOutputLineHandler = (line: string) => void;

export interface ShardAssignment {
  files: string[];
}

interface RunTestBucketsDependencies {
  buildBuckets: (
    mode: TestMode,
    workerCapacity: number,
  ) => Promise<TestBucket[]>;
  runBucket: (
    bucket: TestBucket,
    env: Record<string, string>,
    onOutputLine?: TestOutputLineHandler,
  ) => Promise<TestResult>;
  log: (message: string) => void;
}

export type TestRunnerName = "native" | "custom";

const rootDir = `${import.meta.dir}/..`;
const defaultMaxWorkers = 10;
const MAX_CAPTURED_OUTPUT_CHARACTERS = 256 * 1024;
const MAX_PENDING_LINE_CHARACTERS = 64 * 1024;
const protectedNativeOptions = new Set([
  "--isolate",
  "--max-concurrency",
  "--no-isolate",
  "--no-orphans",
  "--parallel",
  "--preload",
  "--timeout",
]);

const suiteDefinitions: SuiteDefinition[] = [
  {
    id: "native-worker",
    label: "tests/e2e/native-worker-registration.test.ts",
    pattern: "tests/e2e/native-worker-registration.test.ts",
    fileConcurrency: 1,
    argsPrefix: ["test", "--timeout", "120000", "--preload", "./tests/backend-user-context.ts", "--isolate"],
    modes: ["native-worker"],
  },
  {
    id: "unit",
    label: "tests/unit",
    pattern: "tests/unit/**/*.test.{ts,tsx,js,jsx}",
    fileConcurrency: 2,
    argsPrefix: ["test", "--timeout", "30000", "--preload", "./tests/backend-user-context.ts", "--isolate"],
    modes: ["all", "backend"],
  },
  {
    id: "api",
    label: "tests/api",
    pattern: "tests/api/**/*.test.{ts,tsx,js,jsx}",
    fileConcurrency: 2,
    argsPrefix: ["test", "--timeout", "30000", "--preload", "./tests/backend-user-context.ts", "--isolate"],
    modes: ["all", "backend"],
  },
  {
    id: "e2e",
    label: "tests/e2e",
    pattern: "tests/e2e/**/*.test.{ts,tsx,js,jsx}",
    fileConcurrency: 1,
    argsPrefix: ["test", "--timeout", "30000", "--preload", "./tests/backend-user-context.ts", "--isolate"],
    modes: ["all", "backend"],
  },
  {
    id: "integration",
    label: "tests/integration",
    pattern: "tests/integration/**/*.test.{ts,tsx,js,jsx}",
    fileConcurrency: 1,
    argsPrefix: ["test", "--timeout", "30000", "--preload", "./tests/backend-user-context.ts", "--isolate"],
    modes: ["all", "backend"],
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

function assertValidMode(mode: string | undefined): TestMode {
  switch (mode ?? "all") {
    case "all":
      return "all";
    case "backend":
      return "backend";
    case "native-worker":
      return "native-worker";
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

interface CapturedStreamOutput {
  value: string;
  truncated: boolean;
}

function appendBoundedTail(
  current: string,
  next: string,
  maxCharacters: number,
): CapturedStreamOutput {
  const combinedLength = current.length + next.length;
  if (combinedLength <= maxCharacters) {
    return { value: current + next, truncated: false };
  }
  if (next.length >= maxCharacters) {
    return { value: next.slice(-maxCharacters), truncated: true };
  }

  const charactersToRemove = combinedLength - maxCharacters;
  return {
    value: current.slice(charactersToRemove) + next,
    truncated: true,
  };
}

function formatCapturedOutput(
  stdout: CapturedStreamOutput,
  stderr: CapturedStreamOutput,
): string {
  const output = [stdout.value, stderr.value]
    .filter((value) => value.length > 0)
    .join("\n");
  const truncationNotices = [
    stdout.truncated ? `stdout truncated; showing the last ${MAX_CAPTURED_OUTPUT_CHARACTERS} characters` : "",
    stderr.truncated ? `stderr truncated; showing the last ${MAX_CAPTURED_OUTPUT_CHARACTERS} characters` : "",
  ].filter((notice) => notice.length > 0);

  return truncationNotices.length > 0
    ? `${truncationNotices.map((notice) => `[${notice}]`).join("\n")}\n${output}`
    : output;
}

function isTestProgressLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("bun test v")
    || trimmed.startsWith("--changed:")
    || /^tests\/.*:$/.test(trimmed)
    || /^\((pass|fail|skip)\)/.test(trimmed)
    || /^\d+ (pass|fail|skip|expect\(\) calls)/.test(trimmed)
    || /^Ran \d+ tests/.test(trimmed);
}

async function readStream(
  stream: ReadableStream<Uint8Array> | null,
  onLine?: TestOutputLineHandler,
): Promise<CapturedStreamOutput> {
  if (stream === null) {
    return { value: "", truncated: false };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let outputTruncated = false;
  let pendingLine = "";
  let pendingLineTruncated = false;

  const appendPendingLine = (chunk: string): void => {
    const retained = appendBoundedTail(pendingLine, chunk, MAX_PENDING_LINE_CHARACTERS);
    pendingLine = retained.value;
    pendingLineTruncated ||= retained.truncated;
  };

  const flushPendingLine = (): void => {
    if (!pendingLineTruncated) {
      onLine?.(pendingLine.replace(/\r$/, ""));
    }
    pendingLine = "";
    pendingLineTruncated = false;
  };

  const emitLines = (chunk: string, final = false): void => {
    let start = 0;
    let newlineIndex = chunk.indexOf("\n", start);
    while (newlineIndex !== -1) {
      appendPendingLine(chunk.slice(start, newlineIndex));
      flushPendingLine();
      start = newlineIndex + 1;
      newlineIndex = chunk.indexOf("\n", start);
    }
    if (start < chunk.length) {
      appendPendingLine(chunk.slice(start));
    }
    if (final && (pendingLine.length > 0 || pendingLineTruncated)) {
      flushPendingLine();
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      const retained = appendBoundedTail(output, chunk, MAX_CAPTURED_OUTPUT_CHARACTERS);
      output = retained.value;
      outputTruncated ||= retained.truncated;
      emitLines(chunk);
    }
    const finalChunk = decoder.decode();
    const retained = appendBoundedTail(output, finalChunk, MAX_CAPTURED_OUTPUT_CHARACTERS);
    output = retained.value;
    outputTruncated ||= retained.truncated;
    emitLines(finalChunk, true);
  } finally {
    reader.releaseLock();
  }

  return { value: output, truncated: outputTruncated };
}

async function listTestFiles(pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const files = await Array.fromAsync(glob.scan({ cwd: rootDir }));
  return files.sort();
}

async function listTestFilesBySuiteForMode(mode: TestMode): Promise<SuiteFiles[]> {
  const claimedFiles = new Set<string>();
  const suiteFiles: SuiteFiles[] = [];
  for (const suite of suiteDefinitions) {
    if (!suite.modes.includes(mode)) {
      continue;
    }
    const files = (await listTestFiles(suite.pattern)).filter((file) => {
      if (claimedFiles.has(file)) {
        return false;
      }
      claimedFiles.add(file);
      return true;
    });
    if (files.length > 0) {
      suiteFiles.push({ suite, files });
    }
  }
  return suiteFiles;
}

export async function listTestFilesForMode(mode: TestMode): Promise<string[]> {
  const files = new Set<string>();
  for (const suiteFiles of await listTestFilesBySuiteForMode(mode)) {
    for (const file of suiteFiles.files) {
      files.add(file);
    }
  }
  return [...files].sort();
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

export function resolveTestRunner(
  env: Record<string, string>,
  nativeArgs: string[] = [],
): TestRunnerName {
  const requestedRunner = env["CLANKY_TEST_RUNNER"];
  if (requestedRunner === "native" || requestedRunner === "custom") {
    return requestedRunner;
  }
  if (requestedRunner !== undefined && requestedRunner !== "") {
    throw new Error(`Unknown test runner: ${requestedRunner}`);
  }

  const changedSelectionRequested = nativeArgs.some((argument) =>
    argument === "--changed" || argument.startsWith("--changed=")
  );
  if (changedSelectionRequested) {
    return "native";
  }
  return shouldRetryFailedBuckets(env) ? "custom" : "native";
}

export function buildNativeTestArgs(
  files: string[],
  workerCapacity: number,
  nativeArgs: string[] = [],
): string[] {
  for (const argument of nativeArgs) {
    const optionName = argument.split("=", 1)[0];
    if (protectedNativeOptions.has(optionName ?? "")) {
      throw new Error(`Native test argument cannot override runner option: ${optionName}`);
    }
  }
  const normalizedWorkerCapacity = Number.isFinite(workerCapacity)
    ? Math.trunc(workerCapacity)
    : 1;
  return [
    "test",
    "--timeout",
    "30000",
    "--preload",
    "./tests/backend-user-context.ts",
    "--isolate",
    "--max-concurrency",
    "1",
    "--no-orphans",
    `--parallel=${Math.max(1, normalizedWorkerCapacity)}`,
    ...nativeArgs,
    ...files,
  ];
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
  mode: TestMode,
  workerCapacity: number = defaultMaxWorkers,
): Promise<TestBucket[]> {
  const buckets: TestBucket[] = [];

  for (const { suite, files } of await listTestFilesBySuiteForMode(mode)) {
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

async function runBucket(
  bucket: TestBucket,
  env: Record<string, string>,
  onOutputLine?: TestOutputLineHandler,
): Promise<TestResult> {
  const start = Date.now();
  const proc = Bun.spawn({
    cmd: [process.execPath, ...bucket.args],
    cwd: rootDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let streamedProgress = false;
  const emitProgressLine = (line: string): void => {
    if (onOutputLine === undefined || !isTestProgressLine(line)) {
      return;
    }
    streamedProgress = true;
    onOutputLine(line);
  };
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout, emitProgressLine),
    readStream(proc.stderr, emitProgressLine),
    proc.exited,
  ]);

  const output = formatCapturedOutput(stdout, stderr);

  return {
    bucket,
    exitCode,
    output,
    elapsedMs: Date.now() - start,
    outputStreamed: streamedProgress,
  };
}

async function runBuckets(
  buckets: TestBucket[],
  env: Record<string, string>,
  maxWorkers: number,
  runBucketImpl: (
    bucket: TestBucket,
    env: Record<string, string>,
  ) => Promise<TestResult> = runBucket,
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

async function runNativeTests(
  mode: TestMode,
  env: Record<string, string>,
  workerCapacity: number,
  nativeArgs: string[],
  log: (message: string) => void,
): Promise<number> {
  const files = await listTestFilesForMode(mode);
  if (files.length === 0) {
    log(`No ${mode} test files found.`);
    return 1;
  }

  const args = buildNativeTestArgs(files, workerCapacity, nativeArgs);
  log(`Running ${files.length} ${mode} test file(s) with Bun native workers...`);
  log(`Using up to ${Math.max(1, Math.trunc(workerCapacity))} native worker process(es).`);
  log("");

  const startedAt = Date.now();
  const proc = Bun.spawn({
    cmd: [process.execPath, ...args],
    cwd: rootDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const emitProgressLine = (line: string): void => {
    if (isTestProgressLine(line)) {
      log(line);
    }
  };
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout, emitProgressLine),
    readStream(proc.stderr, emitProgressLine),
    proc.exited,
  ]);
  if (stdout.value.length === 0 && stderr.value.length === 0) {
    log("(no test output)");
  } else if (exitCode !== 0) {
    log(formatCapturedOutput(stdout, stderr).trim());
  }
  log("");
  log(`Native test process exited with code ${exitCode} after ${formatDuration(Date.now() - startedAt)}.`);
  return exitCode === 0 ? 0 : 1;
}

async function runCustomTestBuckets(
  modeArg: string | undefined,
  env: Record<string, string>,
  dependencies: Partial<RunTestBucketsDependencies>,
): Promise<number> {
  const mode = assertValidMode(modeArg);
  const startedAt = Date.now();
  const buildBucketsImpl = dependencies.buildBuckets ?? buildBuckets;
  const runBucketImpl = dependencies.runBucket ?? runBucket;
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const configuredMaxWorkers = resolveMaxWorkers(env);
  const buckets = await buildBucketsImpl(mode, configuredMaxWorkers);
  if (buckets.length === 0) {
    log(`No ${mode} test files found.`);
    return 1;
  }
  const maxWorkers = Math.max(1, Math.min(configuredMaxWorkers, buckets.length));

  log(`Running ${buckets.length} test bucket(s) in parallel...`);
  log(`Using up to ${maxWorkers} worker process(es).`);
  for (const bucket of buckets) {
    log(`- ${bucket.label}`);
  }
  log("");

  const executeBucketWithProgress = async (
    bucket: TestBucket,
    bucketEnv: Record<string, string>,
  ): Promise<TestResult> => {
    log(`== ${bucket.label} START ==`);
    let streamedOutput = false;
    const result = await runBucketImpl(bucket, bucketEnv, (line) => {
      streamedOutput = true;
      log(`[${bucket.label}] ${line}`);
    });
    const completedResult = {
      ...result,
      outputStreamed: result.outputStreamed ?? streamedOutput,
    };
    log(formatBucketHeader(completedResult));
    return completedResult;
  };

  const initialResults = await runBuckets(buckets, env, maxWorkers, executeBucketWithProgress);
  const failedResults = initialResults.filter((result) => result.exitCode !== 0);
  const retryResults = new Map<string, TestResult>();

  if (failedResults.length > 0 && shouldRetryFailedBuckets(env)) {
    log(
      `Retrying ${failedResults.length} failed bucket(s) serially with --max-concurrency 1 for transient CI failures...`,
    );
    log("");
    for (const failedResult of failedResults) {
      const retryResult = await executeBucketWithProgress(createRetryBucket(failedResult.bucket), env);
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

    if (retryResult !== undefined) {
      log(formatBucketHeader(result, retryResult));
    }
    const wasStreamed = result.outputStreamed === true || retryResult?.outputStreamed === true;
    const output = wasStreamed && finalExitCode === 0
      ? null
      : formatBucketOutput(result, retryResult);
    if (output !== null) {
      log(output);
    }
    log("");
  }

  log(formatCompletionSummary(Date.now() - startedAt, retryResults.size));
  return failed ? 1 : 0;
}

export async function runTestBuckets(
  modeArg: string | undefined,
  sourceEnv: Record<string, string | undefined> = process.env,
  dependencies: Partial<RunTestBucketsDependencies> = {},
  nativeArgs: string[] = [],
): Promise<number> {
  const mode = assertValidMode(modeArg);
  const env = buildEnv(sourceEnv);
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const configuredMaxWorkers = resolveMaxWorkers(env);
  const hasInjectedDependencies = Object.values(dependencies).some(
    (dependency) => dependency !== undefined,
  );
  if (hasInjectedDependencies || resolveTestRunner(env, nativeArgs) === "custom") {
    if (nativeArgs.length > 0) {
      throw new Error("Native test arguments require the native test runner");
    }
    return await runCustomTestBuckets(mode, env, dependencies);
  }
  return await runNativeTests(mode, env, configuredMaxWorkers, nativeArgs, log);
}

if (import.meta.main) {
  process.exit(await runTestBuckets(process.argv[2], process.env, {}, process.argv.slice(3)));
}
