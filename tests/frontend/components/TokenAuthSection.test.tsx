import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TokenAuthSection } from "@/components/app-settings/token-auth-section";
import { createMockApi } from "../helpers/mock-api";
import { renderWithUser, waitFor } from "../helpers/render";

const api = createMockApi();

describe("TokenAuthSection", () => {
  beforeEach(() => {
    api.reset();
    api.install();
  });

  afterEach(() => {
    api.uninstall();
  });

  test("confirms revocation and only shows active sessions", async () => {
    const sessions = [
      {
        id: "session-active",
        clientId: "active-cli",
        createdAt: "2026-04-21T17:00:00.000Z",
        updatedAt: "2026-04-21T17:05:00.000Z",
        expiresAt: "2026-05-21T17:00:00.000Z",
        lastUsedAt: "2026-04-21T17:05:00.000Z",
        active: true,
      },
      {
        id: "session-revoked",
        clientId: "revoked-cli",
        createdAt: "2026-04-21T16:00:00.000Z",
        updatedAt: "2026-04-21T16:30:00.000Z",
        expiresAt: "2026-05-21T16:00:00.000Z",
        lastUsedAt: "2026-04-21T16:15:00.000Z",
        revokedAt: "2026-04-21T16:30:00.000Z",
        revocationReason: "manual",
        active: false,
      },
    ];

    api.get("/api/auth/issuer", () => ({
      canonicalIssuer: null,
      effectiveIssuer: "urn:clanky:instance:test",
    }));
    api.get("/api/auth/sessions", () => sessions);
    api.delete("/api/auth/sessions/:id", ({ params }) => {
      const session = sessions.find((entry) => entry.id === params["id"]);
      if (session) {
        session.active = false;
        session.revokedAt = "2026-04-21T17:10:00.000Z";
        session.revocationReason = "manual";
      }
      return { success: true };
    }, 200);

    const { user, getByRole, getByText, queryByText, queryByRole } = renderWithUser(<TokenAuthSection />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "CLI sessions" })).toBeTruthy();
    });

    expect(queryByText("active-cli")).toBeTruthy();
    expect(queryByText("revoked-cli")).toBeNull();

    await user.click(getByRole("button", { name: "Revoke" }));

    expect(api.calls("/api/auth/sessions/:id", "DELETE")).toHaveLength(0);
    expect(getByRole("dialog", { name: "Revoke CLI session?" })).toBeTruthy();

    await user.click(getByRole("button", { name: "Revoke session" }));

    await waitFor(() => {
      expect(api.calls("/api/auth/sessions/:id", "DELETE")).toHaveLength(1);
      expect(queryByText("active-cli")).toBeNull();
      expect(queryByRole("dialog", { name: "Revoke CLI session?" })).toBeNull();
    });

    expect(getByText("No active CLI sessions.")).toBeTruthy();
  });
});
