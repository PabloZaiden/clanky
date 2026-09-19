import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvisioningJob } from "@/shared";
import { provisioningManager } from "../../src/core/provisioning-manager";
import { ProvisioningAttempt } from "../../src/core/provisioning/attempt";
import { ProvisioningFailedError } from "../../src/core/provisioning/errors";
import type { ProvisioningJobRecord } from "../../src/core/provisioning/types";
import {
  appendProvisioningJobLog,
  createProvisioningJob,
  loadProvisioningJob,
} from "../../src/persistence/provisioning-jobs";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { runWithCurrentUser } from "../../src/core/user-context";
import { getTestLocalExecutionHostBinding, testOwnerUser } from "../setup";

describe("provisioning job recovery", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-provisioning-recovery-"));
    closeDatabase();
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await initializeDatabase();
    provisioningManager.resetForTesting();
  });

  afterEach(async () => {
    provisioningManager.resetForTesting();
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
  });

  test("marks persisted in-flight jobs interrupted after a server restart", async () => {
    const createdAt = new Date().toISOString();
    const executionHostBinding = await runWithCurrentUser(
      testOwnerUser,
      () => getTestLocalExecutionHostBinding(),
    );
    const job: ProvisioningJob = {
      config: {
        id: crypto.randomUUID(),
        name: "Interrupted workspace",
        executionHostBinding,
        repoUrl: "https://github.com/octocat/interrupted.git",
        basePath: "/workspaces",
        provider: "copilot",
        mode: "provision",
        createdAt,
      },
      state: {
        status: "running",
        currentStep: "devbox_up",
        targetDirectory: "/workspaces/interrupted",
        updatedAt: createdAt,
      },
    };

    createProvisioningJob(testOwnerUser.id, job);
    appendProvisioningJobLog(testOwnerUser.id, job.config.id, {
      id: crypto.randomUUID(),
      source: "system",
      text: "Running devbox up",
      timestamp: createdAt,
      step: "devbox_up",
    });

    const updatedCount = await runWithCurrentUser(
      testOwnerUser,
      () => provisioningManager.reconcileStartupState(),
    );

    expect(updatedCount).toBe(1);
    const recovered = loadProvisioningJob(testOwnerUser.id, job.config.id);
    expect(recovered?.job.state.status).toBe("interrupted");
    expect(recovered?.job.state.error?.code).toBe("server_restarted");
    expect(recovered?.job.state.error?.step).toBe("devbox_up");
    expect(recovered?.logs.some((entry) => entry.text.includes("server restarted"))).toBe(true);

    const secondPassCount = await runWithCurrentUser(
      testOwnerUser,
      () => provisioningManager.reconcileStartupState(),
    );
    expect(secondPassCount).toBe(0);
  });

  test("preserves the primary failure when rollback cleanup also fails", async () => {
    const createdAt = new Date().toISOString();
    const executionHostBinding = await runWithCurrentUser(
      testOwnerUser,
      () => getTestLocalExecutionHostBinding(),
    );
    const job: ProvisioningJob = {
      config: {
        id: crypto.randomUUID(),
        name: "Cleanup failure workspace",
        executionHostBinding,
        repoUrl: "https://github.com/octocat/cleanup-failure.git",
        basePath: "/workspaces",
        provider: "copilot",
        mode: "provision",
        createdAt,
      },
      state: {
        status: "running",
        currentStep: "create_workspace",
        updatedAt: createdAt,
      },
    };
    createProvisioningJob(testOwnerUser.id, job);

    const record: ProvisioningJobRecord = {
      job,
      logs: [],
      abortController: new AbortController(),
      owner: testOwnerUser,
      runnerActive: true,
      secretValues: [],
    };
    const attempt = new ProvisioningAttempt({
      record,
      maxLogEntries: 100,
    });
    record.attempt = attempt;
    attempt.registerCleanup("partially created workspace", () => {
      throw new Error("workspace cleanup failed");
    });

    await runWithCurrentUser(
      testOwnerUser,
      () => attempt.fail(
        new ProvisioningFailedError(
          "primary_failure",
          "create_workspace",
          "The primary provisioning operation failed",
        ),
        "provisioning_failed",
        "create_workspace",
      ),
    );

    const recovered = loadProvisioningJob(testOwnerUser.id, job.config.id);
    expect(recovered?.job.state.status).toBe("failed");
    expect(recovered?.job.state.error).toEqual({
      code: "primary_failure",
      message: "The primary provisioning operation failed",
      step: "create_workspace",
    });
    expect(recovered?.job.state.cleanupErrors).toEqual([{
      resource: "partially created workspace",
      message: "workspace cleanup failed",
    }]);
    expect(recovered?.logs.some((entry) =>
      entry.text.includes("Cleanup failed for partially created workspace"),
    )).toBe(true);
  });
});
