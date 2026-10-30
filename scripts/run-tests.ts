import { availableParallelism } from "node:os";

type TestMode = "all" | "mesh";

interface ArchitectureRule {
  description: string;
  pattern: RegExp;
}

interface TestShard {
  index: number;
  files: string[];
}

interface ShardResult {
  shard: TestShard;
  exitCode: number;
  output: string;
  elapsedMs: number;
}

const rootDirectory = `${import.meta.dir}/..`;
const testFilePattern = "tests/**/*.test.{ts,tsx,js,jsx}";
const e2eTestFilePattern = "tests/e2e/**/*.test.{ts,tsx,js,jsx}";
const e2eSourcePattern = "tests/e2e/**/*.{ts,tsx,js,jsx}";
const meshTestFile = "tests/e2e/mesh-journey.test.ts";
const meshAutomaticTestFile = "tests/e2e/mesh-automatic-workspace-journey.test.ts";
const publicAddressFixtureTestFile = "tests/e2e/workspace-icon-journey.test.ts";

const architectureRules: ArchitectureRule[] = [
  {
    description: "imports production source code",
    pattern: /(?:from\s+|import\s*\()\s*["'][^"']*(?:^|\/)src(?:\/|["'])/m,
  },
  {
    description: "uses the production source alias",
    pattern: /(?:from\s+|import\s*\()\s*["']@\//m,
  },
  {
    description: "uses Bun test mocks or spies",
    pattern: /import\s*\{[^}]*\b(?:mock|spyOn)\b[^}]*\}\s*from\s*["']bun:test["']/s,
  },
  {
    description: "uses an in-process module mock or spy",
    pattern: /\b(?:mock\.module|jest\.|vi\.|spyOn)\s*\(/,
  },
  {
    description: "uses the native route-handler harness",
    pattern: /\bserveNativeApiRoutes\b/,
  },
  {
    description: "uses a production testing hook",
    pattern: /\b\w*ForTest(?:ing|s)\b/,
  },
  {
    description: "accesses persistence directly",
    pattern: /\b(?:bun:sqlite|sqliteWebAppStore|clanky\.db)\b/,
  },
  {
    description: "imports legacy test doubles or setup",
    pattern: /(?:from\s+|import\s*\()\s*["'][^"']*(?:\/mocks\/|\/tests\/setup|\/setup)["']/m,
  },
];

async function globFiles(pattern: string): Promise<string[]> {
  const files = await Array.fromAsync(new Bun.Glob(pattern).scan({
    cwd: rootDirectory,
    onlyFiles: true,
  }));
  return files.sort();
}

function parseMode(rawMode: string | undefined): TestMode {
  if (rawMode === undefined || rawMode === "all") {
    return "all";
  }
  if (rawMode === "mesh") {
    return "mesh";
  }
  throw new Error(`Unknown E2E test mode: ${rawMode}`);
}

function resolveWorkerCapacity(fileCount: number): number {
  const configured = process.env["CLANKY_TEST_MAX_WORKERS"];
  if (configured !== undefined) {
    const parsed = Number.parseInt(configured, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error("CLANKY_TEST_MAX_WORKERS must be a positive integer");
    }
    return Math.min(fileCount, parsed);
  }
  return Math.min(fileCount, Math.max(1, availableParallelism()));
}

function partitionFiles(files: string[], capacity: number): TestShard[] {
  const shardCount = Math.min(files.length, capacity);
  const shards = Array.from({ length: shardCount }, (_, index) => ({
    index,
    files: [] as string[],
  }));
  for (const [index, file] of files.entries()) {
    shards[index % shardCount]!.files.push(file);
  }
  return shards;
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

async function validateTestArchitecture(): Promise<void> {
  const [allTests, e2eTests, e2eSources] = await Promise.all([
    globFiles(testFilePattern),
    globFiles(e2eTestFilePattern),
    globFiles(e2eSourcePattern),
  ]);
  const e2eSet = new Set(e2eTests);
  const violations = allTests
    .filter((file) => !e2eSet.has(file))
    .map((file) => `${file}: automated tests must live under tests/e2e`);

  for (const file of e2eSources) {
    const source = await Bun.file(`${rootDirectory}/${file}`).text();
    for (const rule of architectureRules) {
      const match = rule.pattern.exec(source);
      if (match?.index !== undefined) {
        violations.push(
          `${file}:${String(lineNumberAt(source, match.index))}: ${rule.description}`,
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new Error([
      "E2E architecture guard failed:",
      ...violations.map((violation) => `- ${violation}`),
    ].join("\n"));
  }
}

async function supportsUnprivilegedNetworkNamespaces(): Promise<boolean> {
  const probe = Bun.spawn({
    cmd: ["unshare", "--user", "--map-root-user", "--net", "--", "true"],
    cwd: rootDirectory,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return await probe.exited === 0;
}

async function runTestFiles(
  files: string[],
  isolatedPublicAddressFixture: boolean,
): Promise<{ exitCode: number; output: string }> {
  const testCommand = [
    process.execPath,
    "test",
    "--timeout",
    "120000",
    "--isolate",
    "--no-orphans",
    "--max-concurrency",
    "1",
    ...files,
  ];
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  environment["CLANKY_LOG_LEVEL"] = process.env["CLANKY_LOG_LEVEL"] ?? "fatal";
  delete environment["CLANKY_TEST_PUBLIC_IP_FIXTURE"];
  if (isolatedPublicAddressFixture) {
    environment["CLANKY_TEST_PUBLIC_IP_FIXTURE"] = "1";
  }
  let command = testCommand;
  if (isolatedPublicAddressFixture) {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) {
      throw new Error("The isolated public-IP fixture requires Linux user and group IDs.");
    }

    const wrapper = `${rootDirectory}/tests/e2e/support/with-isolated-public-ip.sh`;
    if (uid === 0) {
      command = [
        "unshare",
        "--net",
        "--",
        "sh",
        wrapper,
        "0",
        "0",
        "--",
        ...testCommand,
      ];
    } else if (await supportsUnprivilegedNetworkNamespaces()) {
      command = [
        "unshare",
        "--user",
        "--map-root-user",
        "--net",
        "--",
        "sh",
        wrapper,
        "0",
        "0",
        "--",
        ...testCommand,
      ];
    } else {
      console.log("Unprivileged network namespaces are disabled; using sudo for the isolated icon fixture.");
      command = [
        "sudo",
        "-n",
        "--preserve-env=PATH,HOME,TMPDIR,CI,GITHUB_ACTIONS,CLANKY_LOG_LEVEL,CLANKY_TEST_PUBLIC_IP_FIXTURE",
        "unshare",
        "--net",
        "--",
        "sh",
        wrapper,
        String(uid),
        String(gid),
        "--",
        ...testCommand,
      ];
    }
  }
  const processHandle = Bun.spawn({
    cmd: command,
    cwd: rootDirectory,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return {
    exitCode,
    output: [stdout, stderr].filter(Boolean).join("\n").trim(),
  };
}

async function runShard(shard: TestShard): Promise<ShardResult> {
  const startedAt = performance.now();
  const useIsolatedPublicAddressFixture = process.platform === "linux";
  const isolatedFiles = useIsolatedPublicAddressFixture
    ? shard.files.filter((file) => file === publicAddressFixtureTestFile)
    : [];
  const isolatedFileSet = new Set<string>(isolatedFiles);
  const regularFiles = shard.files.filter((file) => !isolatedFileSet.has(file));
  const invocations = [
    ...(regularFiles.length > 0 ? [{ files: regularFiles, isolated: false }] : []),
    ...(isolatedFiles.length > 0 ? [{ files: isolatedFiles, isolated: true }] : []),
  ];
  const results: Array<{ exitCode: number; output: string }> = [];
  for (const invocation of invocations) {
    results.push(await runTestFiles(invocation.files, invocation.isolated));
  }
  return {
    shard,
    exitCode: results.find((result) => result.exitCode !== 0)?.exitCode ?? 0,
    output: results.map((result) => result.output).filter(Boolean).join("\n\n"),
    elapsedMs: performance.now() - startedAt,
  };
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv[2]);
  await validateTestArchitecture();
  const discovered = await globFiles(e2eTestFilePattern);
  const meshFiles = new Set([meshTestFile]);
  if (process.platform === "linux" || process.platform === "darwin") {
    meshFiles.add(meshAutomaticTestFile);
  }
  const files = mode === "mesh"
    ? discovered.filter((file) => meshFiles.has(file))
    : discovered;
  if (files.length === 0) {
    throw new Error(`No E2E tests discovered for mode ${mode}`);
  }

  const workerCapacity = resolveWorkerCapacity(files.length);
  const shards = partitionFiles(files, workerCapacity);
  console.log(
    `Running ${String(files.length)} E2E file(s) in ${String(shards.length)} shard(s).`,
  );
  const startedAt = performance.now();
  const results = await Promise.all(shards.map(runShard));
  for (const result of results.sort((left, right) => left.shard.index - right.shard.index)) {
    const label = result.shard.files.join(", ");
    const status = result.exitCode === 0 ? "PASS" : "FAIL";
    console.log(`\n== ${status}: ${label} (${(result.elapsedMs / 1000).toFixed(1)}s) ==`);
    if (result.output.length > 0) {
      console.log(result.output);
    }
  }

  if (results.some((result) => result.exitCode !== 0)) {
    process.exitCode = 1;
    return;
  }
  console.log(`\nE2E suite passed in ${((performance.now() - startedAt) / 1000).toFixed(1)}s.`);
}

await main();
