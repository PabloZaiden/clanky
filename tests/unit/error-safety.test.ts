import { describe, expect, test } from "bun:test";
import { DomainError } from "../../src/core/domain-error";
import { createGitSyncFailure } from "../../src/core/task/task-git-push-helpers";
import { taskFailureFromUnknown } from "../../src/core/task/task-errors";
import { getTerminalErrorPayload } from "../../src/api/websocket/terminal";
import { domainErrorResponse } from "../../src/api/helpers";

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
