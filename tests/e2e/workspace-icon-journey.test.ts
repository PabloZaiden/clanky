import { expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { createPng } from "./support/png-fixtures";
import { requireCommand } from "./support/process";

const PUBLIC_ICON_FIXTURE_ADDRESS = "1.1.1.1";

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

function copyArrayBuffer(bytes: Uint8Array<ArrayBufferLike>): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

interface IconFixture {
  content: Uint8Array<ArrayBufferLike>;
  mimeType: string;
}

async function listenForPublicIconFixture(
  icons: ReadonlyMap<string, IconFixture>,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const icon = icons.get(request.url ?? "");
    if (!icon) {
      response.writeHead(404, { connection: "close" });
      response.end();
      return;
    }
    response.writeHead(200, {
      connection: "close",
      "content-length": icon.content.byteLength,
      "content-type": icon.mimeType,
    });
    response.end(new Uint8Array(copyArrayBuffer(icon.content)));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, PUBLIC_ICON_FIXTURE_ADDRESS);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine the public icon fixture address.");
  }
  return { server, port: address.port };
}

async function closeIconFixture(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("workspace icon settings discover, select, upload, and persist icons", async () => {
  const application = await E2EApplication.create();
  try {
    const git = await createGitFixture(application.runDirectory);
    const svg = '<svg viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></svg>';
    await mkdir(join(git.repositoryDirectory, "assets"), { recursive: true });
    await mkdir(join(git.repositoryDirectory, "zz-filler"), { recursive: true });
    const png = createPng(2, 1);
    await Promise.all([
      Bun.write(join(git.repositoryDirectory, "assets", "artwork.svg"), svg),
      Bun.write(join(git.repositoryDirectory, "assets", "photo.png"), png),
      Bun.write(join(git.repositoryDirectory, "assets", "mark.ico"), createTinyIco()),
      Bun.write(join(git.repositoryDirectory, ".gitignore"), "assets/ignored.png\n"),
      Bun.write(join(git.repositoryDirectory, "assets", "ignored.png"), png),
      ...Array.from({ length: 201 }, (_, index) =>
        Bun.write(
          join(git.repositoryDirectory, "zz-filler", `${String(index).padStart(3, "0")}.svg`),
          svg,
        )
      ),
    ]);
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
    expect(candidateResult.candidates).toHaveLength(200);
    expect(candidateResult.truncated).toBe(true);
    expect(candidateResult.candidates).toContainEqual({
      path: "assets/artwork.svg",
      name: "artwork.svg",
      mimeType: "image/svg+xml",
    });
    expect(candidateResult.candidates).toContainEqual({
      path: "assets/photo.png",
      name: "photo.png",
      mimeType: "image/png",
    });
    expect(candidateResult.candidates).toContainEqual({
      path: "assets/mark.ico",
      name: "mark.ico",
      mimeType: "image/x-icon",
    });
    expect(candidateResult.candidates.some((candidate) => candidate.path === "assets/ignored.png")).toBe(false);

    const selectedIcon = await application.json<{ workspaceIcon: Workspace["workspaceIcon"] }>(
      `/api/workspaces/${workspace.id}/icon`,
      {
        method: "PUT",
        body: JSON.stringify({ path: "assets/artwork.svg" }),
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
    const iconContent = await iconResponse.text();
    expect(iconContent.length).toBeGreaterThan(0);

    const pngWorkspace = (await application.json<Workspace>(
      "/api/workspaces",
      {
        method: "POST",
        body: JSON.stringify({
          name: "PNG icon journey workspace",
          directory: git.repositoryDirectory,
          executionHost: localHost!.ref,
          serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
        }),
      },
      201,
    )).data;

    const upload = new FormData();
    upload.set(
      "icon",
      new File([createTinyIco()], "custom.ico", { type: "image/x-icon" }),
    );
    const uploadedIcon = await application.json<{ workspaceIcon: Workspace["workspaceIcon"] }>(
      `/api/workspaces/${pngWorkspace.id}/icon-upload`,
      { method: "POST", body: upload, apiKey: apiKey.token },
    );
    expect(uploadedIcon.data.workspaceIcon?.mimeType).toBe("image/x-icon");
    const uploadedIconResponse = await application.request(
      `/api/workspaces/${pngWorkspace.id}/icon`,
      { apiKey: apiKey.token },
    );
    expect(uploadedIconResponse.status).toBe(200);
    expect(uploadedIconResponse.headers.get("content-type")).toBe("image/x-icon");
    expect((await uploadedIconResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const pngUpload = new FormData();
    pngUpload.set("icon", new File([copyArrayBuffer(png)], "avatar.png", { type: "image/png" }));
    const uploadedPng = await application.json<{ workspaceIcon: Workspace["workspaceIcon"] }>(
      `/api/workspaces/${pngWorkspace.id}/icon-upload`,
      { method: "POST", body: pngUpload, apiKey: apiKey.token },
    );
    expect(uploadedPng.data.workspaceIcon?.mimeType).toBe("image/x-icon");
    const uploadedPngResponse = await application.request(
      `/api/workspaces/${pngWorkspace.id}/icon`,
      { apiKey: apiKey.token },
    );
    expect(uploadedPngResponse.status).toBe(200);
    expect(uploadedPngResponse.headers.get("content-type")).toBe("image/x-icon");

    const candidatePngPreview = await application.request(
      `/api/workspaces/${pngWorkspace.id}/icon-candidate-preview?path=${
        encodeURIComponent("assets/photo.png")
      }`,
      { apiKey: apiKey.token },
    );
    expect(candidatePngPreview.status).toBe(200);
    expect(candidatePngPreview.headers.get("content-type")).toBe("image/png");
    expect((await candidatePngPreview.arrayBuffer()).byteLength).toBe(png.byteLength);

    const selectedPng = await application.json<{ workspaceIcon: Workspace["workspaceIcon"] }>(
      `/api/workspaces/${pngWorkspace.id}/icon`,
      {
        method: "PUT",
        body: JSON.stringify({ path: "assets/photo.png" }),
        apiKey: apiKey.token,
      },
    );
    expect(selectedPng.data.workspaceIcon?.mimeType).toBe("image/x-icon");
    const selectedPngResponse = await application.request(
      `/api/workspaces/${pngWorkspace.id}/icon`,
      { apiKey: apiKey.token },
    );
    expect(selectedPngResponse.status).toBe(200);
    expect(selectedPngResponse.headers.get("content-type")).toBe("image/x-icon");
    const selectedPngContent = new Uint8Array(await selectedPngResponse.arrayBuffer());
    expect(selectedPngContent.byteLength).toBeGreaterThan(70);
    expect(selectedPngContent[0]).toBe(0);
    expect(selectedPngContent[1]).toBe(0);
    expect(selectedPngContent[2]).toBe(1);

    const blockedUrlResponse = await application.request(
      `/api/workspaces/${pngWorkspace.id}/icon-url-import`,
      {
        method: "POST",
        body: JSON.stringify({ url: "http://127.0.0.1:12345/icon.svg" }),
        apiKey: apiKey.token,
      },
    );
    expect(blockedUrlResponse.status).toBe(400);
    expect((await blockedUrlResponse.json() as { error: string }).error)
      .toBe("workspace_icon_url_blocked");

    const blockedIpv4CompatibleUrlResponse = await application.request(
      `/api/workspaces/${pngWorkspace.id}/icon-url-import`,
      {
        method: "POST",
        body: JSON.stringify({ url: "http://[::a9fe:a9fe]:12345/icon.svg" }),
        apiKey: apiKey.token,
      },
    );
    expect(blockedIpv4CompatibleUrlResponse.status).toBe(400);
    expect((await blockedIpv4CompatibleUrlResponse.json() as { error: string }).error)
      .toBe("workspace_icon_url_blocked");

    const invalidSchemeResponse = await application.request(
      `/api/workspaces/${pngWorkspace.id}/icon-url-import`,
      {
        method: "POST",
        body: JSON.stringify({ url: "file:///etc/hosts" }),
        apiKey: apiKey.token,
      },
    );
    expect(invalidSchemeResponse.status).toBe(400);
    expect((await invalidSchemeResponse.json() as { error: string }).error)
      .toBe("workspace_icon_url_invalid");

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
    expect(await persistedIconResponse.text()).toBe(iconContent);

    const persistedPngWorkspace = (await application.json<Workspace>(
      `/api/workspaces/${pngWorkspace.id}`,
      { apiKey: apiKey.token },
    )).data;
    expect(persistedPngWorkspace.workspaceIcon).toEqual(selectedPng.data.workspaceIcon);
    const persistedPngResponse = await application.request(
      `/api/workspaces/${pngWorkspace.id}/icon`,
      { apiKey: apiKey.token },
    );
    expect(persistedPngResponse.status).toBe(200);
    expect(persistedPngResponse.headers.get("content-type")).toBe("image/x-icon");
    expect(new Uint8Array(await persistedPngResponse.arrayBuffer())).toEqual(selectedPngContent);
  } finally {
    await application.cleanup();
  }
});

if (
  process.platform === "linux"
  && process.env["CLANKY_TEST_PUBLIC_IP_FIXTURE"] === "1"
) {
  test("workspace icon URL imports preview, save, and persist SVG, PNG, and ICO", async () => {
    const links = await requireCommand(["ip", "-o", "link", "show"], { cwd: process.cwd() });
    expect(links.stdout.trim().split("\n").map((line) => line.split(":")[1]?.trim()))
      .toEqual(["lo"]);
    const defaultRoute = await requireCommand(["ip", "route", "show", "default"], {
      cwd: process.cwd(),
    });
    expect(defaultRoute.stdout.trim()).toBe("");
    const loopbackAddress = await requireCommand(["ip", "-o", "address", "show", "dev", "lo"], {
      cwd: process.cwd(),
    });
    expect(loopbackAddress.stdout).toContain(`inet ${PUBLIC_ICON_FIXTURE_ADDRESS}/32`);

    const application = await E2EApplication.create();
    let fixtureServer: Server | null = null;
    try {
      const svg = Buffer.from(
        '<svg viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></svg>',
      );
      const sanitizedSvg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1h14v14H1z"></path></svg>',
      );
      const png = createPng(2, 1);
      const ico = new Uint8Array(createTinyIco());
      const fixtures = new Map<string, IconFixture>([
        ["/workspace.svg", { content: svg, mimeType: "image/svg+xml" }],
        ["/workspace.png", { content: png, mimeType: "image/png" }],
        ["/workspace.ico", { content: ico, mimeType: "image/x-icon" }],
      ]);
      const fixture = await listenForPublicIconFixture(fixtures);
      fixtureServer = fixture.server;
      const git = await createGitFixture(application.runDirectory);
      await application.start();

      const apiKey = (await application.json<ApiKey>(
        "/api/api-keys",
        {
          method: "POST",
          body: JSON.stringify({ name: "Workspace icon URL journey", scopes: ["*"] }),
        },
      )).data;
      const hosts = (await application.json<Array<{ ref: Record<string, string> }>>(
        "/api/execution-hosts",
      )).data;
      const localHost = hosts.find((host) => host.ref["kind"] === "local");
      expect(localHost).toBeDefined();

      const iconCases = [
        {
          fileName: "workspace.svg",
          fixturePath: "/workspace.svg",
          mimeType: "image/svg+xml",
          name: "URL SVG workspace icon",
          previewContent: sanitizedSvg,
          savedMimeType: "image/svg+xml",
          storedContent: sanitizedSvg,
        },
        {
          fileName: "workspace.png",
          fixturePath: "/workspace.png",
          mimeType: "image/png",
          name: "URL PNG workspace icon",
          previewContent: png,
          savedMimeType: "image/x-icon",
          storedContent: null,
        },
        {
          fileName: "workspace.ico",
          fixturePath: "/workspace.ico",
          mimeType: "image/x-icon",
          name: "URL ICO workspace icon",
          previewContent: ico,
          savedMimeType: "image/x-icon",
          storedContent: ico,
        },
      ] as const;
      const savedIcons: Array<{
        content: ArrayBuffer;
        mimeType: string;
        workspace: Workspace;
      }> = [];

      for (const iconCase of iconCases) {
        const workspace = (await application.json<Workspace>(
          "/api/workspaces",
          {
            method: "POST",
            body: JSON.stringify({
              name: iconCase.name,
              directory: git.repositoryDirectory,
              executionHost: localHost!.ref,
              serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
            }),
          },
          201,
        )).data;
        const previewResponse = await application.request(
          `/api/workspaces/${workspace.id}/icon-url-import`,
          {
            method: "POST",
            body: JSON.stringify({
              url: `http://${PUBLIC_ICON_FIXTURE_ADDRESS}:${String(fixture.port)}${iconCase.fixturePath}`,
            }),
            apiKey: apiKey.token,
          },
        );
        expect(previewResponse.status).toBe(200);
        expect(previewResponse.headers.get("content-type")).toBe(iconCase.mimeType);
        const previewContent = new Uint8Array(await previewResponse.arrayBuffer());
        expect(Array.from(previewContent)).toEqual(Array.from(iconCase.previewContent));

        const unsavedWorkspace = (await application.json<Workspace>(
          `/api/workspaces/${workspace.id}`,
          { apiKey: apiKey.token },
        )).data;
        expect(unsavedWorkspace.workspaceIcon ?? null).toBeNull();

        const upload = new FormData();
        upload.set(
          "icon",
          new File([copyArrayBuffer(previewContent)], iconCase.fileName, {
            type: iconCase.mimeType,
          }),
        );
        const saved = await application.json<{ workspaceIcon: Workspace["workspaceIcon"] }>(
          `/api/workspaces/${workspace.id}/icon-upload`,
          { method: "POST", body: upload, apiKey: apiKey.token },
        );
        expect(saved.data.workspaceIcon?.mimeType).toBe(iconCase.savedMimeType);

        const storedResponse = await application.request(
          `/api/workspaces/${workspace.id}/icon`,
          { apiKey: apiKey.token },
        );
        expect(storedResponse.status).toBe(200);
        expect(storedResponse.headers.get("content-type")).toBe(iconCase.savedMimeType);
        const storedContent = new Uint8Array(await storedResponse.arrayBuffer());
        if (iconCase.storedContent) {
          expect(Array.from(storedContent)).toEqual(Array.from(iconCase.storedContent));
        } else {
          const icoHeader = new DataView(
            storedContent.buffer,
            storedContent.byteOffset,
            storedContent.byteLength,
          );
          expect(icoHeader.getUint16(0, true)).toBe(0);
          expect(icoHeader.getUint16(2, true)).toBe(1);
          expect(icoHeader.getUint16(4, true)).toBeGreaterThan(0);
        }
        savedIcons.push({
          content: copyArrayBuffer(storedContent),
          mimeType: iconCase.savedMimeType,
          workspace: { ...workspace, workspaceIcon: saved.data.workspaceIcon },
        });
      }

      await application.restart();
      for (const savedIcon of savedIcons) {
        const persistedWorkspace = (await application.json<Workspace>(
          `/api/workspaces/${savedIcon.workspace.id}`,
          { apiKey: apiKey.token },
        )).data;
        expect(persistedWorkspace.workspaceIcon).toEqual(savedIcon.workspace.workspaceIcon);
        const persistedResponse = await application.request(
          `/api/workspaces/${savedIcon.workspace.id}/icon`,
          { apiKey: apiKey.token },
        );
        expect(persistedResponse.status).toBe(200);
        expect(persistedResponse.headers.get("content-type")).toBe(savedIcon.mimeType);
        expect(await persistedResponse.arrayBuffer()).toEqual(savedIcon.content);
      }
    } finally {
      try {
        await application.cleanup();
      } finally {
        if (fixtureServer) {
          await closeIconFixture(fixtureServer);
        }
      }
    }
  });
}
