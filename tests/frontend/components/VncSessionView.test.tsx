import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getStoredVncCredentials, storeVncCredentials } from "@/lib/vnc-browser-credentials";
import type { SshServer, VncSession } from "@/types";
import { createMockApi } from "../helpers/mock-api";
import { renderWithUser, waitFor } from "../helpers/render";

const api = createMockApi();

mock.module("@/components/app-shell/VncViewer", () => ({
  VncViewer: () => <div>VNC viewer</div>,
}));

function createServer(): SshServer {
  return {
    config: {
      id: "server-1",
      name: "Build Box",
      address: "10.0.0.5",
      username: "vscode",
      repositoriesBasePath: "/workspaces",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
    },
    publicKey: {
      algorithm: "RSA-OAEP-256",
      publicKey: "public-key",
      fingerprint: "fingerprint",
      version: 1,
      createdAt: "2026-05-28T00:00:00.000Z",
    },
  };
}

function createVncSession(): VncSession {
  return {
    config: {
      id: "vnc-session-1",
      sshServerId: "server-1",
      remoteHost: "127.0.0.1",
      remotePort: 5900,
      localPort: 6080,
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
    },
    state: {
      status: "active",
      pid: 123,
    },
  };
}

function storeSshCredentialShape(): void {
  window.localStorage.setItem("clanky.sshServerCredential.server-1", JSON.stringify({
    encryptedCredential: {
      algorithm: "RSA-OAEP-256",
      fingerprint: "fingerprint",
      version: 1,
      ciphertext: "ciphertext",
    },
    storedAt: "2026-05-28T00:00:00.000Z",
  }));
}

describe("VncSessionView", () => {
  beforeEach(() => {
    api.reset();
    api.install();
    window.localStorage.clear();
  });

  afterEach(() => {
    api.uninstall();
  });

  test("prefills and updates encrypted client-side VNC credentials", async () => {
    const { VncSessionView } = await import("@/components/app-shell/vnc-session-view");
    await storeVncCredentials("server-1", { username: "", password: "saved-vnc-secret" });
    storeSshCredentialShape();
    api.get("/api/ssh-servers/:id/vnc-sessions", () => []);
    api.get("/api/ssh-servers/:id/public-key", () => createServer().publicKey);
    api.post("/api/ssh-servers/:id/credentials", () => ({
      credentialToken: "credential-token",
      expiresAt: "2026-05-28T03:00:00.000Z",
    }));
    api.post("/api/ssh-servers/:id/vnc-sessions", () => createVncSession());

    const { getByRole, user } = renderWithUser(
      <VncSessionView
        server={createServer()}
        onNavigate={() => {}}
      />,
    );

    const passwordInput = document.querySelector("input[type='password']") as HTMLInputElement | null;
    const usernameInput = getByRole("textbox", { name: "VNC username" }) as HTMLInputElement;
    await waitFor(() => {
      expect(usernameInput.value).toBe("");
      expect(passwordInput?.value).toBe("saved-vnc-secret");
    });

    await user.type(usernameInput, "changed-vnc-user");
    await user.clear(passwordInput!);
    await user.type(passwordInput!, "changed-vnc-secret");
    await user.click(getByRole("button", { name: "Start VNC Session" }));

    await waitFor(() => {
      expect(api.calls("/api/ssh-servers/:id/vnc-sessions", "POST")).toHaveLength(1);
    });
    expect(await getStoredVncCredentials("server-1")).toEqual({
      username: "changed-vnc-user",
      password: "changed-vnc-secret",
    });
    expect(window.localStorage.getItem("clanky.vncPassword.server-1")).not.toContain("changed-vnc-secret");
    expect(window.localStorage.getItem("clanky.vncPassword.server-1")).not.toContain("changed-vnc-user");
  });
});
