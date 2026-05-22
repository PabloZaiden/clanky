import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "@/App";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";

const api = createMockApi();
const ws = createMockWebSocket();

describe("App device approval route", () => {
  beforeEach(() => {
    api.reset();
    api.install();
    ws.reset();
    ws.install();
    window.history.replaceState({}, "", "/device?user_code=ABCD-EFGH");
    window.location.hash = "";
  });

  afterEach(() => {
    api.uninstall();
    ws.uninstall();
    window.history.replaceState({}, "", "/");
    window.location.hash = "";
  });

  test("renders the device approval screen and approves requests", async () => {
    api.get("/api/config", () => ({
      remoteOnly: false,
      passkeyAuth: {
        passkeyConfigured: true,
        passkeyDisabled: false,
        passkeyRequired: true,
        authenticated: true,
      },
      publicBasePath: null,
    }));
    api.get("/api/auth/device/verification", () => ({
      userCode: "ABCD-EFGH",
      clientId: "clanky-cli",
      scope: "tasks:read",
      status: "pending",
      expiresAt: "2099-04-21T15:00:00.000Z",
      passkeyRequired: true,
    }));
    api.post("/api/auth/device/approve", () => ({
      userCode: "ABCD-EFGH",
      clientId: "clanky-cli",
      scope: "tasks:read",
      status: "approved",
      expiresAt: "2099-04-21T15:00:00.000Z",
      passkeyRequired: true,
    }), 200);

    const { user, getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Approve CLI access" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(api.calls("/api/auth/device/approve", "POST")).toHaveLength(1);
      expect(getByRole("button", { name: "Approve" })).toBeDisabled();
    });
  });
});
