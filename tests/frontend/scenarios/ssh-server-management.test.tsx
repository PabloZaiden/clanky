/**
 * E2E Scenario: Standalone SSH server management
 *
 * Tests shell-native workflows for editing a registered standalone SSH server.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "@/App";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";
import { createModelInfo } from "../helpers/factories";
import type { SshServer, SshServerSession } from "@/types";

const api = createMockApi();
const ws = createMockWebSocket();

function setupBaseApi() {
  api.get("/api/config", () => ({ remoteOnly: false }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/loops", () => []);
  api.get("/api/workspaces", () => []);
  api.get("/api/ssh-sessions", () => []);
  api.get("/api/preferences/last-model", () => null);
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  api.get("/api/preferences/last-directory", () => null);
  api.get("/api/models", () => [createModelInfo({ connected: true })]);
  api.get("/api/git/branches", () => ({
    branches: [{ name: "main", isCurrent: true, isDefault: true }],
    currentBranch: "main",
  }));
  api.get("/api/git/default-branch", () => ({ defaultBranch: "main" }));
  api.get("/api/check-planning-dir", () => ({ warning: null }));
}

beforeEach(() => {
  api.reset();
  api.install();
  ws.reset();
  ws.install();
  window.location.hash = "";
});

afterEach(() => {
  api.uninstall();
  ws.uninstall();
  window.location.hash = "";
});

describe("ssh server management scenario", () => {
  test("editing a standalone SSH server opens the composer with existing values", async () => {
    setupBaseApi();

    const server: SshServer = {
      config: {
        id: "server-1",
        name: "Build Box",
        address: "10.0.0.5",
        username: "vscode",
        repositoriesBasePath: "/workspaces",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      publicKey: {
        algorithm: "RSA-OAEP-256",
        publicKey: "public-key",
        fingerprint: "fingerprint",
        version: 1,
        createdAt: new Date().toISOString(),
      },
    };

    const sessions: SshServerSession[] = [{
      config: {
        id: "standalone-session-1",
        sshServerId: server.config.id,
        name: "Deploy Shell",
        connectionMode: "dtach",
        remoteSessionName: "ralpher-standalone-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      state: {
        status: "ready",
      },
    }];

    api.get("/api/ssh-servers", () => [server]);
    api.get("/api/ssh-servers/:id/sessions", () => sessions);

    const { getByRole, getByText, user } = renderWithUser(<App />, {
      route: "#/server/server-1",
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Build Box" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Edit Server" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/new/ssh-server/server-1");
      expect(getByRole("heading", { name: "Edit Build Box" })).toBeTruthy();
    });

    const nameInput = document.querySelector("#server-name") as HTMLInputElement | null;
    const addressInput = document.querySelector("#server-address") as HTMLInputElement | null;
    const usernameInput = document.querySelector("#server-username") as HTMLInputElement | null;
    const basePathInput = document.querySelector("#server-repositories-base-path") as HTMLInputElement | null;

    expect(nameInput?.value).toBe("Build Box");
    expect(addressInput?.value).toBe("10.0.0.5");
    expect(usernameInput?.value).toBe("vscode");
    expect(basePathInput?.value).toBe("/workspaces");
    expect(getByText(/future connections and provisioning actions/i)).toBeTruthy();
  });
});
