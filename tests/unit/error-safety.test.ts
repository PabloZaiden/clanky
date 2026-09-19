import { describe, expect, test } from "bun:test";
import { DomainError } from "../../src/core/domain-error";
import { createGitSyncFailure } from "../../src/core/task/task-git-push-helpers";
import { taskFailureFromUnknown } from "../../src/core/task/task-errors";
import { getTerminalErrorPayload } from "../../src/api/websocket/terminal";
import { domainErrorResponse } from "../../src/api/helpers";
import { chatActionErrorResponse } from "../../src/api/chats/helpers";
import { createAcpConnectionTimeoutError } from "../../src/backends/acp";

describe("typed error safety boundaries", () => {
  test("uses a fixed payload for unknown terminal bridge errors", () => {
    const payload = getTerminalErrorPayload(
      new Error("ssh://user:secret@example.test:22: permission denied"),
    );

    expect(payload).toEqual({ message: "SSH terminal connection failed" });
  });

  test("preserves the safe message for known terminal domain errors", () => {
    const payload = getTerminalErrorPayload(
      new DomainError("invalid_credential_token", "SSH credential token is missing or expired"),
    );

    expect(payload).toEqual({
      code: "invalid_credential_token",
      message: "SSH credential token is missing or expired",
    });
  });

  test("does not expose messages from unknown terminal domain errors", () => {
    const payload = getTerminalErrorPayload(
      new DomainError("internal_error", "ssh stderr contains a private endpoint"),
    );

    expect(payload).toEqual({ message: "SSH terminal connection failed" });
  });

  test("preserves typed Mesh status and code contracts", async () => {
    const enrollmentResponse = domainErrorResponse(
      new DomainError("mesh_enrollment_target_invalid", "private target"),
      {
        policy: "mesh",
        fallback: {
          error: "mesh_operation_failed",
          message: "Mesh operation failed",
          status: 500,
        },
      },
    );
    expect(enrollmentResponse.status).toBe(400);
    expect(await enrollmentResponse.json()).toEqual({
      error: "mesh_enrollment_target_invalid",
      message: "The Mesh enrollment target is invalid.",
    });

    const executionResponse = domainErrorResponse(
      new DomainError("mesh_execution_request_invalid", "private request"),
      {
        policy: "mesh-internal",
        fallback: {
          error: "mesh_internal_request_failed",
          message: "Mesh internal request failed",
          status: 500,
        },
      },
    );
    expect(executionResponse.status).toBe(400);
    expect(await executionResponse.json()).toEqual({
      error: "mesh_execution_request_invalid",
      message: "The Mesh execution request is invalid.",
    });
  });

  test("preserves Mesh fallback aliases for status-only failures", async () => {
    const response = domainErrorResponse(
      new DomainError("mesh_worker_not_found", "private worker identifier"),
      {
        policy: "mesh",
        fallback: {
          error: "mesh_operation_failed",
          message: "Mesh operation failed",
          status: 500,
        },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "mesh_operation_failed",
      message: "Mesh operation failed",
    });
  });

  test("keeps task model validation failures on the typed 400 path", async () => {
    for (const code of [
      "cheap_model_not_enabled",
      "model_not_found",
      "provider_not_found",
      "validation_failed",
    ]) {
      const response = domainErrorResponse(
        new DomainError(code, "private model validation details"),
        {
          policy: "tasks",
          fallback: {
            error: "create_failed",
            message: "Failed to create task",
            status: 500,
          },
        },
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(code);
    }
  });

  test("preserves workspace and enrollment not-found aliases", async () => {
    const workspaceResponse = domainErrorResponse(
      new DomainError("workspace_not_found", "legacy workspace message"),
      {
        policy: "workspaces",
        fallback: {
          error: "delete_failed",
          message: "Failed to delete workspace",
          status: 500,
        },
      },
    );
    expect(workspaceResponse.status).toBe(404);
    expect(await workspaceResponse.json()).toEqual({
      error: "workspace_not_found",
      message: "Workspace not found",
    });

    const enrollmentResponse = domainErrorResponse(
      new DomainError("workspace_worker_enrollment_not_found", "legacy enrollment message"),
      {
        policy: "mesh",
        mappings: {
          workspace_worker_enrollment_not_found: {
            error: "not_found",
            message: "Workspace worker enrollment not found",
            status: 404,
          },
        },
        fallback: {
          error: "mesh_operation_failed",
          message: "Mesh operation failed",
          status: 500,
        },
      },
    );
    expect(enrollmentResponse.status).toBe(404);
    expect(await enrollmentResponse.json()).toEqual({
      error: "not_found",
      message: "Workspace worker enrollment not found",
    });
  });

  test("preserves typed SSH transport and legacy agent messages", async () => {
    expect(
      getTerminalErrorPayload(
        new DomainError("ssh_server_not_found", "private SSH server identifier"),
      ),
    ).toEqual({
      code: "ssh_server_not_found",
      message: "SSH server not found",
    });

    const response = domainErrorResponse(
      new DomainError("agent_run_not_ready", "Agent run cannot be interrupted because its chat has not been created yet"),
      {
        policy: "agents",
        fallback: {
          error: "interrupt_agent_failed",
          message: "Failed to interrupt agent",
          status: 500,
        },
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "agent_run_not_ready",
      message: "Agent run cannot be interrupted because its chat has not been created yet",
    });
  });

  test("preserves chat timeout response contracts for SSH and non-SSH transports", async () => {
    const nonSshResponse = chatActionErrorResponse(
      createAcpConnectionTimeoutError(5000),
    );
    if (!nonSshResponse) {
      throw new Error("Expected a non-SSH timeout response");
    }
    expect(nonSshResponse.status).toBe(504);
    expect(await nonSshResponse.json()).toEqual({
      error: "connection_timeout",
      message: "The agent connection timed out before it became ready",
    });

    const sshResponse = chatActionErrorResponse(
      createAcpConnectionTimeoutError(5000, { transport: "ssh" }),
    );
    if (!sshResponse) {
      throw new Error("Expected an SSH timeout response");
    }
    expect(sshResponse.status).toBe(504);
    expect(await sshResponse.json()).toEqual({
      error: "ssh_connection_timeout",
      message: "The SSH connection timed out before the agent became ready",
    });
  });

  test("uses boundary policy messages instead of known domain messages", async () => {
    const response = domainErrorResponse(
      new DomainError(
        "voice_provider_request_failed",
        "provider response includes a private endpoint",
      ),
      {
        policy: "voice",
        fallback: {
          error: "voice_failed",
          message: "Voice request failed",
          status: 500,
        },
      },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "voice_provider_request_failed",
      message: "The voice provider request failed.",
    });
  });

  test("keeps only approved structured details and headers", async () => {
    const response = domainErrorResponse(
      new DomainError("voice_provider_rate_limited", "private provider details", {
        details: {
          retryAfter: "30",
          secret: "do-not-return",
        },
      }),
      {
        policy: "voice",
        fallback: {
          error: "voice_failed",
          message: "Voice request failed",
          status: 500,
        },
      },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.json()).toEqual({
      error: "voice_provider_rate_limited",
      message: "The voice provider rate-limited the request.",
    });
  });

  test("uses a fixed fallback for unknown domain errors", async () => {
    const response = domainErrorResponse(
      new DomainError("internal_provider_failure", "private endpoint and credentials"),
      {
        policy: "mesh",
        fallback: {
          error: "mesh_operation_failed",
          message: "Mesh operation failed",
          status: 500,
        },
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "mesh_operation_failed",
      message: "Mesh operation failed",
    });
  });

  test("uses a fixed message and safe details for git sync failures", () => {
    const result = createGitSyncFailure("task-1", "fixture-default");

    if (result.success) {
      throw new Error("Expected git sync failure");
    }

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "task_git_operation_failed",
        message: "Task git operation failed",
        details: {
          taskId: "task-1",
          branch: "fixture-default",
        },
      },
    });
    expect(result.error.details).not.toHaveProperty("stderr");
  });

  test("does not copy unknown error messages into task failure details", () => {
    const result = taskFailureFromUnknown(
      new Error("remote=https://user:secret@example.test/repo"),
      "task_git_operation_failed",
      "Task git operation failed",
    );

    expect(result.error.details).toEqual({});
  });
});
