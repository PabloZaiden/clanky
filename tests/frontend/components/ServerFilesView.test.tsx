import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderWithUser, waitFor } from "../helpers/render";
import { createMockApi, MockApiError } from "../helpers/mock-api";
import { storeSshServerPassword } from "@/lib/ssh-browser-credentials";
import type { SshServer } from "@/types";

mock.module("@monaco-editor/react", () => ({
  default: ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (value: string) => void;
  }) => (
    <textarea
      aria-label="Monaco editor"
      value={value ?? ""}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

const api = createMockApi();
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

function createServer(): SshServer {
  return {
    config: {
      id: "server-1",
      name: "Build Box",
      address: "10.0.0.5",
      username: "vscode",
      repositoriesBasePath: "/srv/app/current",
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
}

function createTreeResponse(entriesByDirectory: Record<string, Array<{
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
  versionToken: string;
}>>) {
  return { entriesByDirectory };
}

describe("ServerFilesView", () => {
  beforeEach(() => {
    api.reset();
    api.install();
    window.localStorage.clear();
    api.get("/api/preferences/file-explorer-full-tree", () => ({ enabled: true }));
  });

  afterEach(() => {
    api.uninstall();
    mock.restore();
  });

  test("resets the SSH-backed explorer root from the shared root picker dialog", async () => {
    const { ServerFilesView } = await import("@/components/app-shell/server-files-view");
    const onNavigate = mock((_route: unknown) => {});
    const server = createServer();

    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", () => ({
      credentialToken: "token-123",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    api.get("/api/ssh-servers/:id/files/tree", () => ({
      serverId: server.config.id,
      ...createTreeResponse({
        "": [],
      }),
    }));

    await storeSshServerPassword(server.config.id, "super-secret");

    const { getByLabelText, getByRole, queryByLabelText, user } = renderWithUser(
      <ServerFilesView
        server={server}
        sessions={[]}
        startDirectory="/srv/app"
        createStandaloneSession={async () => {
          throw new Error("not used");
        }}
        onNavigate={onNavigate}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "Change explorer root" })).toBeInTheDocument();
    });
    expect(queryByLabelText("Explorer root directory")).not.toBeInTheDocument();

    await user.click(getByRole("button", { name: "Change explorer root" }));
    await waitFor(() => {
      expect(getByLabelText("Explorer root directory")).toHaveValue("/srv/app");
    });

    await user.click(getByRole("button", { name: "Reset root" }));

    expect(onNavigate).toHaveBeenCalledWith({
      view: "server-files",
      serverId: server.config.id,
      startDirectory: undefined,
    });
    expect(queryByLabelText("Explorer root directory")).not.toBeInTheDocument();
  });

  test("asks for the SSH password before starting the server code explorer when none is saved", async () => {
    const { ServerFilesView } = await import("@/components/app-shell/server-files-view");
    const server = createServer();

    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", () => ({
      credentialToken: "token-123",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    api.get("/api/ssh-servers/:id/files/tree", () => ({
      serverId: server.config.id,
      ...createTreeResponse({
        "": [],
      }),
    }));

    const { getByLabelText, getByRole, queryByText, user } = renderWithUser(
      <ServerFilesView
        server={server}
        sessions={[]}
        createStandaloneSession={async () => {
          throw new Error("not used");
        }}
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(queryByText(`Enter the SSH password for ${server.config.name} before opening its code explorer.`))
        .toBeInTheDocument();
    });
    expect(api.calls("/api/ssh-servers/:id/files/tree", "GET")).toHaveLength(0);

    await user.type(getByLabelText("SSH password"), "super-secret");
    await user.click(getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(api.calls("/api/ssh-servers/:id/files/tree", "GET")).toHaveLength(1);
    });
  });

  test("keeps the SSH password modal open while the password submission is still running", async () => {
    const { ServerFilesView } = await import("@/components/app-shell/server-files-view");
    const onNavigate = mock((_route: unknown) => {});
    const server = createServer();
    let resolveCredentialExchange = () => {};

    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", async () => {
      await new Promise<void>((resolve) => {
        resolveCredentialExchange = resolve;
      });
      return {
        credentialToken: "token-123",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    });
    api.get("/api/ssh-servers/:id/files/tree", () => ({
      serverId: server.config.id,
      ...createTreeResponse({
        "": [],
      }),
    }));

    const { getByLabelText, getByRole, queryByLabelText, queryByText, user } = renderWithUser(
      <ServerFilesView
        server={server}
        sessions={[]}
        createStandaloneSession={async () => {
          throw new Error("not used");
        }}
        onNavigate={onNavigate}
      />,
    );

    await waitFor(() => {
      expect(queryByText(`Enter the SSH password for ${server.config.name} before opening its code explorer.`))
        .toBeInTheDocument();
    });

    await user.type(getByLabelText("SSH password"), "super-secret");
    await user.click(getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(api.calls("/api/ssh-servers/:id/credentials", "POST")).toHaveLength(1);
      expect(getByRole("button", { name: "Cancel" })).toBeDisabled();
    });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(queryByText(`Enter the SSH password for ${server.config.name} before opening its code explorer.`))
      .toBeInTheDocument();
    expect(queryByLabelText("Close")).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(api.calls("/api/ssh-servers/:id/files/tree", "GET")).toHaveLength(0);

    resolveCredentialExchange();

    await waitFor(() => {
      expect(api.calls("/api/ssh-servers/:id/files/tree", "GET")).toHaveLength(1);
    });
  });

  test("shows the full-tree loading error without falling back to lazy-loading", async () => {
    const { ServerFilesView } = await import("@/components/app-shell/server-files-view");
    const server = createServer();

    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", () => ({
      credentialToken: "token-123",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    api.get("/api/ssh-servers/:id/files/tree", () => {
      throw new MockApiError(500, {
        error: "ssh_server_file_error",
        message: "Loading the full file tree took too long. Choose a narrower explorer root or turn off \"Load everything at once\".",
      });
    });
    await storeSshServerPassword(server.config.id, "super-secret");

    const { getByRole, queryByRole } = renderWithUser(
      <ServerFilesView
        server={server}
        sessions={[]}
        createStandaloneSession={async () => {
          throw new Error("not used");
        }}
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getByRole("alert").textContent).toContain("Loading the full file tree took too long.");
    });

    expect(queryByRole("button", { name: "src" })).not.toBeInTheDocument();
    expect(api.calls("/api/ssh-servers/:id/files/tree", "GET")).toHaveLength(1);
    expect(api.calls("/api/ssh-servers/:id/files", "GET")).toHaveLength(0);
  });
});
