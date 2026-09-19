import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvisioningJob } from "@/shared";
import { backendManager } from "../../src/core/backend-manager";
import { provisioningManager } from "../../src/core/provisioning-manager";
import { ProvisioningAttempt } from "../../src/core/provisioning/attempt";
import { ProvisioningFailedError } from "../../src/core/provisioning/errors";
import type { ProvisioningJobRecord } from "../../src/core/provisioning/types";
import {
  appendProvisioningJobLog,
  createProvisioningJob,
  loadProvisioningJob,
} from "../../src/persistence/provisioning-jobs";
import {
  claimWorkspaceWorkerEnrollment,
  createWorkspaceWorkerEnrollment,
  getWorkspaceWorkerEnrollment,
  markWorkspaceWorkerConnected,
} from "../../src/persistence/workspace-worker-enrollments";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { runWithCurrentUser } from "../../src/core/user-context";
import { ProvisioningTestExecutor } from "../mocks/provisioning-test-executor";
import { getTestLocalExecutionHostBinding, testOwnerUser } from "../setup";

describe("provisioning job recovery", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-provisioning-recovery-"));
    closeDatabase();
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await initializeDatabase();
    backendManager.resetForTesting();
    provisioningManager.resetForTesting();
  });

  afterEach(async () => {
    provisioningManager.resetForTesting();
    backendManager.resetForTesting();
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

  test("releases an interrupted externally supplied worker claim", async () => {
    const createdAt = new Date().toISOString();
    const executionHostBinding = await runWithCurrentUser(
      testOwnerUser,
      () => getTestLocalExecutionHostBinding(),
    );
    const enrollment = createWorkspaceWorkerEnrollment({
      userId: testOwnerUser.id,
      name: "Interrupted external worker",
      ttlSeconds: 900,
      controller: {
        nodeId: "controller-node",
        fingerprint: "controller-fingerprint",
      },
    });
    markWorkspaceWorkerConnected({
      userId: testOwnerUser.id,
      enrollmentId: enrollment.enrollment.id,
      workerNodeId: "interrupted-worker",
    });
    const job: ProvisioningJob = {
      config: {
        id: crypto.randomUUID(),
        name: "Interrupted external worker workspace",
        executionHostBinding,
        workspaceWorkerEnrollmentId: enrollment.enrollment.id,
        transport: "ssh",
        repoUrl: "https://github.com/octocat/interrupted-external.git",
        basePath: "/workspaces",
        provider: "copilot",
        mode: "provision",
        createdAt,
      },
      state: {
        status: "running",
        currentStep: "devbox_up",
        updatedAt: createdAt,
      },
    };
    claimWorkspaceWorkerEnrollment({
      userId: testOwnerUser.id,
      enrollmentId: enrollment.enrollment.id,
      claimedBy: job.config.id,
    });
    createProvisioningJob(testOwnerUser.id, job);

    await runWithCurrentUser(
      testOwnerUser,
      () => provisioningManager.reconcileDedicatedWorkerStartupState(),
    );

    const recoveredEnrollment = getWorkspaceWorkerEnrollment(
      testOwnerUser.id,
      enrollment.enrollment.id,
    );
    expect(recoveredEnrollment?.status).toBe("connected");
    expect(recoveredEnrollment?.claimedBy).toBeNull();
    expect(recoveredEnrollment?.workspaceId).toBeNull();
    expect(loadProvisioningJob(testOwnerUser.id, job.config.id)?.job.state.status)
      .toBe("interrupted");
  });

  test("cleans an interrupted worker process through the selected host", async () => {
    const executor = new ProvisioningTestExecutor();
    backendManager.setExecutorFactoryForTesting(() => executor);
    const createdAt = new Date().toISOString();
    const executionHostBinding = await runWithCurrentUser(
      testOwnerUser,
      () => getTestLocalExecutionHostBinding(),
    );
    const enrollment = createWorkspaceWorkerEnrollment({
      userId: testOwnerUser.id,
      name: "Interrupted process worker",
      ttlSeconds: 900,
      controller: {
        nodeId: "controller-node",
        fingerprint: "controller-fingerprint",
      },
    });
    markWorkspaceWorkerConnected({
      userId: testOwnerUser.id,
      enrollmentId: enrollment.enrollment.id,
      workerNodeId: "interrupted-process-worker",
    });
    const job: ProvisioningJob = {
      config: {
        id: crypto.randomUUID(),
        name: "Interrupted process workspace",
        executionHostBinding,
        workerEnrollmentId: enrollment.enrollment.id,
        transport: "worker",
        repoUrl: "https://github.com/octocat/interrupted-process.git",
        basePath: "/workspaces",
        provider: "copilot",
        mode: "provision",
        createdAt,
      },
      state: {
        status: "running",
        currentStep: "devbox_up",
        targetDirectory: "/workspaces/interrupted-process",
        resolvedDirectory: "/devbox/workspaces/interrupted-process",
        updatedAt: createdAt,
      },
    };
    createProvisioningJob(testOwnerUser.id, job);

    await runWithCurrentUser(
      testOwnerUser,
      () => provisioningManager.reconcileDedicatedWorkerStartupState(),
    );

    expect(executor.calls.some((call) =>
      call.command === "sh"
      && call.args.some((arg) =>
        arg.includes("/devbox/workspaces/interrupted-process/.devbox/clanky-worker/worker.pid"),
      )
    )).toBe(true);
  });

  test("persists startup worker cleanup failures on the interrupted job", async () => {
    const executor = new ProvisioningTestExecutor({
      failWorkerProcessCleanup: true,
    });
    backendManager.setExecutorFactoryForTesting(() => executor);
    const createdAt = new Date().toISOString();
    const executionHostBinding = await runWithCurrentUser(
      testOwnerUser,
      () => getTestLocalExecutionHostBinding(),
    );
    const enrollment = createWorkspaceWorkerEnrollment({
      userId: testOwnerUser.id,
      name: "Cleanup failure worker",
      ttlSeconds: 900,
      controller: {
        nodeId: "controller-node",
        fingerprint: "controller-fingerprint",
      },
    });
    markWorkspaceWorkerConnected({
      userId: testOwnerUser.id,
      enrollmentId: enrollment.enrollment.id,
      workerNodeId: "cleanup-failure-worker",
    });
    const job: ProvisioningJob = {
      config: {
        id: crypto.randomUUID(),
        name: "Cleanup failure process workspace",
        executionHostBinding,
        workerEnrollmentId: enrollment.enrollment.id,
        transport: "worker",
        repoUrl: "https://github.com/octocat/cleanup-process.git",
        basePath: "/workspaces",
        provider: "copilot",
        mode: "provision",
        createdAt,
      },
      state: {
        status: "running",
        currentStep: "devbox_up",
        targetDirectory: "/workspaces/cleanup-process",
        resolvedDirectory: "/devbox/workspaces/cleanup-process",
        updatedAt: createdAt,
      },
    };
    createProvisioningJob(testOwnerUser.id, job);

    await runWithCurrentUser(
      testOwnerUser,
      () => provisioningManager.reconcileDedicatedWorkerStartupState(),
    );

    const recovered = loadProvisioningJob(testOwnerUser.id, job.config.id);
    expect(recovered?.job.state.cleanupErrors).toContainEqual({
      resource: `workspace worker process for enrollment ${enrollment.enrollment.id}`,
      message: "worker process cleanup failed",
    });
    expect(recovered?.logs.some((entry) =>
      entry.text.includes("Cleanup failed for workspace worker process"),
    )).toBe(true);
  });
});
