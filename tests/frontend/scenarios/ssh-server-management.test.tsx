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
const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAsKNhd9E/OQ+lbqKlfYjv
69xGawOr9J0cMf2Qj3jWXaXv6mm1xrDBMYNboWkjxV6AZAG9zDJO6s8eP/rj7s3P
7dfmoHGRfqoItqqt6WkKxZxjrnDc0l43wcdGaGm0fL5f4enJv+0Ft9Y+BSHhMl+m
ENb+JvTFFK3bz38eLI8Td2RLIqjQ+bTR0M55VdlyIJvtZ4bAzn9IdABzd8hIp/Fq
ZI97s5nsyDqX5ePG7e9UY9kfF4sxhQ1jlwmkIYlQmVl3zY6fWihc+YVHL7XWE/90
cwJp+7qyc0w90j+5vMuJcfFm7F8FG7Zz+oOkkeNbeqMHEaJwVIi9vtHbljH5jtmd
Tib0ROswpXTuhp2cDEgfZiF5m6o6Yws1eIqUhYaEfpOUqseYjPe6Klbjyl90m7Xq
QpPbjq5q7UL/ase5r4n4t0JgcLZw1oP98rVAx+VFE+UViVd9qqH7CFhxxR9t7LFa
NwUWw/pj0oI3Qul2lJfXaogfXzdcguVRik/yi0zQ5p5ArRBPEtmeNcEqA9x1ApNQ
h8ND8r3lVAjFrX8+pj1fmPSxaIXgQPywAzr5kgdWz3BOEkrd5alvd+6kLxC2ErMA
tYXzrp47C+1F7elWjBhHsqlhHSl7zQxqXqetisXZ4uEyv+4S0M3O+Q+iLeidcbLQ
Vrt5VIv2q/QnK29KDywKJrsCAwEAAQ==
-----END PUBLIC KEY-----`;

function setupBaseApi() {
  api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/tasks", () => []);
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

function createServer(): SshServer {
  return {
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
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    },
  };
}

function createStandaloneSession(serverId: string): SshServerSession {
  return {
    config: {
      id: "standalone-session-1",
      sshServerId: serverId,
      name: "Deploy Shell",
      connectionMode: "dtach",
      useTmux: true,
      remoteSessionName: "clanky-standalone-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    state: {
      status: "ready",
    },
  };
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
  test("opening SSH server settings shows the existing values and saves changes back to the server route", async () => {
    setupBaseApi();
    const server = createServer();
    const sessions: SshServerSession[] = [createStandaloneSession(server.config.id)];

    api.get("/api/ssh-servers", () => [server]);
    api.get("/api/ssh-servers/:id/sessions", () => sessions);

    api.patch("/api/ssh-servers/:id", (req) => {
      expect(req.params["id"]).toBe("server-1");
      expect(req.body).toEqual({
        name: "Build Box Updated",
      });

      return {
        ...server,
        config: {
          ...server.config,
          name: "Build Box Updated",
          updatedAt: new Date().toISOString(),
        },
      };
    });

    const { getByRole, getByText, user } = renderWithUser(<App />, {
      route: "#/server/server-1",
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Build Box" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "SSH server actions for Build Box" }));
    await user.click(getByRole("menuitem", { name: "SSH Server Settings" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/server-settings/server-1");
      expect(getByRole("heading", { name: "SSH Server Settings" })).toBeTruthy();
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

    await user.type(nameInput!, " Updated");
    await user.click(getByRole("button", { name: /Save/ }));

    await waitFor(() => {
      expect(api.calls("/api/ssh-servers/:id", "PATCH")).toHaveLength(1);
      expect(window.location.hash).toBe("#/server/server-1");
      expect(getByRole("heading", { name: "Build Box Updated" })).toBeTruthy();
    });
  });

  test("direct edit routes hydrate the composer after SSH servers finish loading", async () => {
    setupBaseApi();

    const server = createServer();

    api.get("/api/ssh-servers", () => [server]);
    api.get("/api/ssh-servers/:id/sessions", () => []);

    const { getByRole } = renderWithUser(<App />, {
      route: "#/new/ssh-server/server-1",
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Edit Build Box" })).toBeTruthy();
    });

    await waitFor(() => {
      const nameInput = document.querySelector("#server-name") as HTMLInputElement | null;
      const addressInput = document.querySelector("#server-address") as HTMLInputElement | null;
      const usernameInput = document.querySelector("#server-username") as HTMLInputElement | null;
      const basePathInput = document.querySelector("#server-repositories-base-path") as HTMLInputElement | null;

      expect(nameInput?.value).toBe("Build Box");
      expect(addressInput?.value).toBe("10.0.0.5");
      expect(usernameInput?.value).toBe("vscode");
      expect(basePathInput?.value).toBe("/workspaces");
    });
  });

  test("password-only edits save the client credential without calling PATCH", async () => {
    setupBaseApi();

    const server = createServer();

    api.get("/api/ssh-servers", () => [server]);
    api.get("/api/ssh-servers/:id/sessions", () => []);
    api.get("/api/ssh-servers/:id/public-key", () => server.publicKey);

    const { getByRole, user } = renderWithUser(<App />, {
      route: "#/new/ssh-server/server-1",
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Edit Build Box" })).toBeTruthy();
    });

    const passwordInput = document.querySelector("#server-password") as HTMLInputElement | null;
    expect(passwordInput).toBeTruthy();

    await user.type(passwordInput!, "super-secret");
    await user.click(getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/server/server-1");
      expect(getByRole("heading", { name: "Build Box" })).toBeTruthy();
    });

    expect(api.calls("/api/ssh-servers/:id", "PATCH")).toHaveLength(0);
    expect(localStorage.getItem("clanky.sshServerCredential.server-1")).toBeTruthy();
  });

  test("checks server prerequisites from SSH server settings", async () => {
    setupBaseApi();
    const server = createServer();

    api.get("/api/ssh-servers", () => [server]);
    api.get("/api/ssh-servers/:id/sessions", () => []);
    api.post("/api/ssh-servers/:id/prerequisites/check", (req) => {
      expect(req.params["id"]).toBe("server-1");
      return {
        serverId: "server-1",
        checkedAt: "2026-04-05T15:00:00.000Z",
        summary: {
          status: "missing_requirements",
          availableCount: 2,
          missingCount: 1,
          notApplicableCount: 5,
          unknownCount: 0,
        },
        checks: [
          {
            id: "ssh_connection",
            label: "SSH connectivity",
            status: "available",
            details: "Clanky can connect to this host and execute remote commands.",
            requiredFor: ["Connecting to this SSH server"],
          },
          {
            id: "bash",
            label: "bash",
            status: "available",
            details: "bash is available on the remote host.",
            requiredFor: ["Standalone SSH sessions", "Automatic provisioning", "devbox arise"],
          },
          {
            id: "dtach",
            label: "dtach",
            status: "missing",
            details: "dtach is not installed or not available on PATH on the remote host.",
            requiredFor: ["Persistent SSH sessions"],
            installHint: "Install dtach with your package manager.",
          },
          {
            id: "devbox",
            label: "devbox",
            status: "not_applicable",
            details: "Automatic provisioning is disabled for this server because no repositories base path is configured.",
            requiredFor: ["Automatic provisioning", "devbox arise"],
          },
          {
            id: "docker",
            label: "docker",
            status: "not_applicable",
            details: "Automatic provisioning is disabled for this server because no repositories base path is configured.",
            requiredFor: ["Automatic provisioning"],
          },
          {
            id: "devcontainer",
            label: "devcontainer",
            status: "not_applicable",
            details: "Automatic provisioning is disabled for this server because no repositories base path is configured.",
            requiredFor: ["Automatic provisioning"],
          },
          {
            id: "git",
            label: "git",
            status: "not_applicable",
            details: "Automatic provisioning is disabled for this server because no repositories base path is configured.",
            requiredFor: ["Automatic provisioning"],
          },
          {
            id: "gh",
            label: "gh",
            status: "not_applicable",
            details: "Automatic provisioning is disabled for this server because no repositories base path is configured.",
            requiredFor: ["Automatic provisioning"],
          },
        ],
      };
    });

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />, {
      route: "#/server-settings/server-1",
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "SSH Server Settings" })).toBeTruthy();
    });

    expect(getByText(/This check verifies SSH connectivity,/)).toHaveTextContent(
      /This check verifies SSH connectivity,\s*bash,\s*dtach,\s*and the automatic provisioning toolchain:\s*devbox,\s*docker,\s*devcontainer,\s*git,\s*and\s*gh\./,
    );

    await user.click(getByRole("button", { name: "Check prerequisites" }));

    await waitFor(() => {
      expect(api.calls("/api/ssh-servers/:id/prerequisites/check", "POST")).toHaveLength(1);
      expect(getByText("Missing requirements")).toBeTruthy();
      expect(getByText("dtach")).toBeTruthy();
      expect(getByText("Install hint:")).toBeTruthy();
      expect(getAllByText("Not applicable")).toHaveLength(5);
    });
  });
});
