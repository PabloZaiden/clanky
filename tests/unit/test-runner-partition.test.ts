import { describe, expect, test } from "bun:test";
import {
  buildBuckets,
  buildNativeTestArgs,
  listTestFilesForMode,
  partitionFiles,
  resolveMaxWorkers,
  resolveTestRunner,
  type TestBucket,
} from "../../scripts/run-tests";

function filesFromBucket(bucket: TestBucket): string[] {
  const maxConcurrencyIndex = bucket.args.indexOf("--max-concurrency");
  return bucket.args.slice(maxConcurrencyIndex + 2);
}

describe("test runner partitioning", () => {
  test("partitions files deterministically and evenly by count", () => {
    const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts", "tests/e.test.ts"];

    expect(partitionFiles(files, 2)).toEqual([
      { files: ["tests/a.test.ts", "tests/c.test.ts", "tests/e.test.ts"] },
      { files: ["tests/b.test.ts", "tests/d.test.ts"] },
    ]);
    expect(partitionFiles(files, 2)).toEqual(partitionFiles(files, 2));
    expect(partitionFiles(files, 10)).toHaveLength(files.length);
    expect(partitionFiles(files, 0)).toEqual([{ files }]);
    expect(partitionFiles(files, -1)).toEqual([{ files }]);
  });

  test("returns no shards for an empty suite", () => {
    expect(partitionFiles([], 10)).toEqual([]);
  });

  test("resolves worker capacity without allowing invalid values to disable execution", () => {
    expect(resolveMaxWorkers({})).toBe(10);
    expect(resolveMaxWorkers({ CLANKY_TEST_MAX_WORKERS: "invalid" })).toBe(10);
    expect(resolveMaxWorkers({ CLANKY_TEST_MAX_WORKERS: "0" })).toBe(10);
    expect(resolveMaxWorkers({ CLANKY_TEST_MAX_WORKERS: "-2" })).toBe(1);
    expect(resolveMaxWorkers({ CLANKY_TEST_MAX_WORKERS: "3" })).toBe(3);
  });

  test("selects native execution by default and preserves custom retry mode", () => {
    expect(resolveTestRunner({})).toBe("native");
    expect(resolveTestRunner({ CI: "true" })).toBe("custom");
    expect(resolveTestRunner({ CLANKY_TEST_RETRY_FAILED_BUCKETS: "1" })).toBe("custom");
    expect(resolveTestRunner({}, ["--changed=HEAD"])).toBe("native");
    expect(resolveTestRunner({ CLANKY_TEST_RUNNER: "custom" })).toBe("custom");
    expect(resolveTestRunner({ CLANKY_TEST_RUNNER: "native", CI: "true" })).toBe("native");
    expect(() => resolveTestRunner({ CLANKY_TEST_RUNNER: "unknown" })).toThrow("Unknown test runner");
  });

  test("builds a native command with deterministic worker and safety flags", () => {
    expect(buildNativeTestArgs(["tests/a.test.ts"], 4, ["--shard=1/2"])).toEqual([
      "test",
      "--dots",
      "--timeout",
      "30000",
      "--preload",
      "./tests/backend-user-context.ts",
      "--isolate",
      "--max-concurrency",
      "1",
      "--no-orphans",
      "--parallel=4",
      "--shard=1/2",
      "tests/a.test.ts",
    ]);
    expect(buildNativeTestArgs([], Number.NaN)).toContain("--parallel=1");
    expect(() => buildNativeTestArgs([], 4, ["--parallel=2"])).toThrow(
      "cannot override runner option: --parallel",
    );
    expect(() => buildNativeTestArgs([], 4, ["--no-isolate"])).toThrow(
      "cannot override runner option: --no-isolate",
    );
  });

  test("builds complete mode-specific buckets from discovered files", async () => {
    const backendBuckets = await buildBuckets("backend", 2);
    const allBuckets = await buildBuckets("all", 2);

    expect(backendBuckets.length).toBeGreaterThan(0);
    expect(allBuckets.length).toBeGreaterThanOrEqual(backendBuckets.length);

    for (const buckets of [backendBuckets, allBuckets]) {
      if (buckets.length === 0) {
        continue;
      }
      const files = buckets.flatMap(filesFromBucket);
      expect(files.length).toBeGreaterThan(0);
      expect(new Set(files).size).toBe(files.length);
      expect(buckets.every((bucket) => filesFromBucket(bucket).length > 0)).toBe(true);
    }
  });

  test("discovers each mode once without duplicate files", async () => {
    const allFiles = await listTestFilesForMode("all");
    const backendFiles = await listTestFilesForMode("backend");

    expect(allFiles.length).toBeGreaterThan(0);
    expect(new Set(allFiles).size).toBe(allFiles.length);
    expect(allFiles).toEqual([...allFiles].sort());
    expect(backendFiles).toEqual(allFiles);
  });
});
