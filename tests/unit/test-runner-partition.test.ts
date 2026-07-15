import { describe, expect, test } from "bun:test";
import {
  buildBuckets,
  partitionFiles,
  resolveMaxWorkers,
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

  test("builds complete mode-specific buckets from discovered files", async () => {
    const backendBuckets = await buildBuckets("backend", 2);
    const frontendBuckets = await buildBuckets("frontend", 2);
    const allBuckets = await buildBuckets("all", 2);

    expect(backendBuckets.length).toBeGreaterThan(0);
    expect(allBuckets.length).toBeGreaterThanOrEqual(backendBuckets.length);
    expect(backendBuckets.every((bucket) => !bucket.id.startsWith("frontend-"))).toBe(true);
    expect(frontendBuckets.every((bucket) => bucket.id.startsWith("frontend-"))).toBe(true);

    for (const buckets of [backendBuckets, frontendBuckets, allBuckets]) {
      if (buckets.length === 0) {
        continue;
      }
      const files = buckets.flatMap(filesFromBucket);
      expect(files.length).toBeGreaterThan(0);
      expect(new Set(files).size).toBe(files.length);
      expect(buckets.every((bucket) => filesFromBucket(bucket).length > 0)).toBe(true);
    }
  });
});
