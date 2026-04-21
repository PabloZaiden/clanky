import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  consumeApprovedDeviceAuthRequest,
  createDeviceAuthRequest,
  createRefreshSession,
  getDeviceAuthRequestByUserCode,
  getRefreshSessionById,
  listLatestRefreshSessions,
  rotateRefreshSessionAtomically,
  type CreateRefreshSessionInput,
} from "../../src/persistence/auth";
import { getDatabase } from "../../src/persistence/database";
import { setupTestContext, teardownTestContext, type TestContext } from "../setup";

function createRefreshSessionInput(input: {
  id: string;
  familyId: string;
  clientId?: string;
  parentSessionId?: string;
  refreshTokenHash?: string;
}): CreateRefreshSessionInput {
  return {
    id: input.id,
    familyId: input.familyId,
    subject: "ralpher-user",
    clientId: input.clientId ?? "ralpher-cli-tests",
    scope: "loops:read",
    refreshTokenHash: input.refreshTokenHash ?? `${input.id}-hash`,
    refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    parentSessionId: input.parentSessionId,
  };
}

describe("auth persistence", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestContext();
  });

  afterEach(async () => {
    await teardownTestContext(context);
  });

  test("consumes approved device requests at most once", async () => {
    await createDeviceAuthRequest({
      id: "request-1",
      clientId: "ralpher-cli-tests",
      deviceCodeHash: "device-hash-1",
      userCode: "ABCD-EFGH",
      scope: "loops:read",
      status: "approved",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      approvedAt: new Date().toISOString(),
      pollCount: 0,
      subject: "ralpher-user",
    });

    const firstSession = createRefreshSessionInput({
      id: "session-1",
      familyId: "family-1",
    });
    const secondSession = createRefreshSessionInput({
      id: "session-2",
      familyId: "family-1",
      refreshTokenHash: "session-2-hash",
    });

    expect(await consumeApprovedDeviceAuthRequest("request-1", firstSession)).toBe(true);
    expect(await consumeApprovedDeviceAuthRequest("request-1", secondSession)).toBe(false);

    await expect(getDeviceAuthRequestByUserCode("ABCD-EFGH")).resolves.toEqual(expect.objectContaining({
      status: "consumed",
      sessionId: "session-1",
      subject: "ralpher-user",
    }));
    await expect(getRefreshSessionById("session-1")).resolves.toEqual(expect.objectContaining({
      id: "session-1",
      familyId: "family-1",
    }));
    await expect(getRefreshSessionById("session-2")).resolves.toBeUndefined();
  });

  test("rotates refresh sessions at most once", async () => {
    const currentSession = createRefreshSessionInput({
      id: "session-current",
      familyId: "family-rotation",
    });
    await createRefreshSession(currentSession);

    const firstSuccessor = createRefreshSessionInput({
      id: "session-next-1",
      familyId: "family-rotation",
      parentSessionId: "session-current",
    });
    const secondSuccessor = createRefreshSessionInput({
      id: "session-next-2",
      familyId: "family-rotation",
      parentSessionId: "session-current",
      refreshTokenHash: "session-next-2-hash",
    });

    expect(await rotateRefreshSessionAtomically("session-current", firstSuccessor)).toBe(true);
    expect(await rotateRefreshSessionAtomically("session-current", secondSuccessor)).toBe(false);

    await expect(getRefreshSessionById("session-current")).resolves.toEqual(expect.objectContaining({
      id: "session-current",
      revocationReason: "rotated",
      replacedBySessionId: "session-next-1",
    }));
    await expect(getRefreshSessionById("session-next-1")).resolves.toEqual(expect.objectContaining({
      id: "session-next-1",
      parentSessionId: "session-current",
    }));
    await expect(getRefreshSessionById("session-next-2")).resolves.toBeUndefined();
  });

  test("lists only the latest refresh session per family", async () => {
    await createRefreshSession(createRefreshSessionInput({
      id: "family-a-old",
      familyId: "family-a",
    }));
    await createRefreshSession(createRefreshSessionInput({
      id: "family-a-new",
      familyId: "family-a",
      refreshTokenHash: "family-a-new-hash",
    }));
    await createRefreshSession(createRefreshSessionInput({
      id: "family-b-only",
      familyId: "family-b",
    }));

    const db = getDatabase();
    db.run("UPDATE auth_refresh_sessions SET created_at = ?, updated_at = ? WHERE id = ?", [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "family-a-old",
    ]);
    db.run("UPDATE auth_refresh_sessions SET created_at = ?, updated_at = ? WHERE id = ?", [
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "family-a-new",
    ]);
    db.run("UPDATE auth_refresh_sessions SET created_at = ?, updated_at = ? WHERE id = ?", [
      "2026-01-03T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
      "family-b-only",
    ]);

    await expect(listLatestRefreshSessions()).resolves.toEqual([
      expect.objectContaining({ id: "family-b-only", familyId: "family-b" }),
      expect.objectContaining({ id: "family-a-new", familyId: "family-a" }),
    ]);
  });
});
