import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";

interface ApiKey {
  token: string;
}

interface Workspace {
  id: string;
  name: string;
  workspaceIcon?: {
    mimeType: string;
    updatedAt: string;
  };
}

interface WorkspaceIconCandidates {
  candidates: Array<{
    path: string;
    name: string;
    mimeType: string;
  }>;
  truncated: boolean;
}

function createTinyIco(): ArrayBuffer {
  const icon = new Uint8Array(new ArrayBuffer(70));
  const view = new DataView(icon.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  icon[6] = 1;
  icon[7] = 1;
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, 48, true);
  view.setUint32(18, 22, true);
  view.setUint32(22, 40, true);
  view.setInt32(26, 1, true);
  view.setInt32(30, 2, true);
  view.setUint16(34, 1, true);
  view.setUint16(36, 32, true);
  view.setUint32(42, 4, true);
  icon.set([0x30, 0x80, 0xe0, 0xff], 62);
  return icon.buffer;
}

test("workspace icon settings discover, select, upload, and persist icons", async () => {
  const application = await E2EApplication.create();
  try {
    const git = await createGitFixture(application.runDirectory);
    const svg = '<svg viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></svg>';
    await mkdir(join(git.repositoryDirectory, "assets"), { recursive: true });
    await mkdir(join(git.repositoryDirectory, "packages"), { recursive: true });
    await Bun.write(join(git.repositoryDirectory, "workspace-icon.svg"), svg);
    await Bun.write(join(git.repositoryDirectory, "assets", "my-icon.svg"), svg);
    await Bun.write(join(git.repositoryDirectory, "packages", "product-logo.svg"), svg);
    await application.start();

    const apiKey = (await application.json<ApiKey>(
      "/api/api-keys",
      {
        method: "POST",
        body: JSON.stringify({ name: "Workspace icon journey", scopes: ["*"] }),
      },
    )).data;
    const hosts = (await application.json<Array<{ ref: Record<string, string> }>>(
      "/api/execution-hosts",
    )).data;
    const localHost = hosts.find((host) => host.ref["kind"] === "local");
    expect(localHost).toBeDefined();

    const workspace = (await application.json<Workspace>(
      "/api/workspaces",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Icon journey workspace",
          directory: git.repositoryDirectory,
          executionHost: localHost!.ref,
          serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
        }),
      },
      201,
    )).data;

    const candidateResult = (await application.json<WorkspaceIconCandidates>(
      `/api/workspaces/${workspace.id}/icon-candidates`,
    )).data;
    expect(candidateResult.candidates.map((candidate) => candidate.path)).toEqual(
      expect.arrayContaining([
        "workspace-icon.svg",
        "assets/my-icon.svg",
        "packages/product-logo.svg",
      ]),
    );

    const selectedIcon = await application.json<{ workspaceIcon: Workspace["workspaceIcon"] }>(
      `/api/workspaces/${workspace.id}/icon`,
      {
        method: "PUT",
        body: JSON.stringify({ path: "assets/my-icon.svg" }),
        apiKey: apiKey.token,
      },
    );
    expect(selectedIcon.data.workspaceIcon?.mimeType).toBe("image/svg+xml");

    const iconResponse = await application.request(
      `/api/workspaces/${workspace.id}/icon?updatedAt=${
        encodeURIComponent(selectedIcon.data.workspaceIcon!.updatedAt)
      }`,
      { apiKey: apiKey.token },
    );
    expect(iconResponse.status).toBe(200);
    expect(iconResponse.headers.get("content-type")).toBe("image/svg+xml");
    expect(await iconResponse.text()).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
    );

    await application.restart({ disablePasskey: false });
    const persistedWorkspace = (await application.json<Workspace>(
      `/api/workspaces/${workspace.id}`,
      { apiKey: apiKey.token },
    )).data;
    expect(persistedWorkspace.workspaceIcon).toEqual(selectedIcon.data.workspaceIcon);

    const persistedIconResponse = await application.request(
      `/api/workspaces/${workspace.id}/icon`,
      { apiKey: apiKey.token },
    );
    expect(persistedIconResponse.status).toBe(200);
    expect(persistedIconResponse.headers.get("content-type")).toBe("image/svg+xml");
    expect(await persistedIconResponse.text()).toContain(
      '<path d="M1 1h14v14H1z"></path>',
    );

    const upload = new FormData();
    upload.set(
      "icon",
      new File([createTinyIco()], "custom.ico", { type: "image/x-icon" }),
    );
    const uploadedIcon = await application.json<{ workspaceIcon: Workspace["workspaceIcon"] }>(
      `/api/workspaces/${workspace.id}/icon-upload`,
      { method: "POST", body: upload, apiKey: apiKey.token },
    );
    expect(uploadedIcon.data.workspaceIcon?.mimeType).toBe("image/x-icon");
    const uploadedIconResponse = await application.request(
      `/api/workspaces/${workspace.id}/icon`,
      { apiKey: apiKey.token },
    );
    expect(uploadedIconResponse.status).toBe(200);
    expect(uploadedIconResponse.headers.get("content-type")).toBe("image/x-icon");
    expect((await uploadedIconResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);
  } finally {
    await application.cleanup();
  }
});
