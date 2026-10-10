import { afterEach, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { E2EApplication } from "./support/application";
import { requireCommand } from "./support/process";

interface UpgradeManifest {
  source: {
    commit: string;
    tag: string;
    schemaVersion: number;
  };
  generation: {
    dataDirectorySnapshotSha256: string;
  };
  expected: {
    apiKey: string;
    chat: string;
    githubUsername: string;
    task: string;
    workspace: string;
  };
}

interface Workspace {
  id: string;
  name: string;
  scratchpad: string;
}

interface TaskSummary {
  config: {
    id: string;
    name: string;
  };
  state: {
    status: string;
  };
}

interface ChatSummary {
  config: {
    id: string;
    name: string;
    useChatNameAsBranch: boolean;
  };
}

interface ApiKey {
  id: string;
  name: string;
}

interface UpgradeSnapshot {
  apiKeyId: string;
  chatId: string;
  githubUsername: string;
  taskId: string;
  taskStatus: string;
  workspaceId: string;
}

const FIXTURE_DIRECTORY = resolve(
  import.meta.dir,
  "fixtures",
  "upgrade-v5.4.1",
);

let application: E2EApplication | undefined;

afterEach(async () => {
  await application?.cleanup();
  application = undefined;
});

async function restorePreviousVersionData(
  app: E2EApplication,
): Promise<UpgradeManifest> {
  const manifest = await Bun.file(
    join(FIXTURE_DIRECTORY, "manifest.json"),
  ).json() as UpgradeManifest;
  const archivePath = join(FIXTURE_DIRECTORY, "data-directory.tar.gz");
  const actualSha256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archivePath).arrayBuffer())
    .digest("hex");
  if (actualSha256 !== manifest.generation.dataDirectorySnapshotSha256) {
    throw new Error(
      `Upgrade fixture checksum mismatch: expected ${manifest.generation.dataDirectorySnapshotSha256}, received ${actualSha256}`,
    );
  }
  await requireCommand(
    [
      "tar",
      "-xzf",
      archivePath,
      "-C",
      app.dataDirectory,
    ],
    { cwd: app.runDirectory },
  );
  return manifest;
}

async function readUpgradeSnapshot(
  app: E2EApplication,
  manifest: UpgradeManifest,
): Promise<UpgradeSnapshot> {
  const workspaces = (await app.json<Workspace[]>("/api/workspaces")).data;
  const workspace = workspaces.find(
    (candidate) => candidate.name === manifest.expected.workspace,
  );
  expect(workspace).toBeDefined();

  const tasks = (await app.json<TaskSummary[]>("/api/tasks")).data;
  const task = tasks.find(
    (candidate) => candidate.config.name === manifest.expected.task,
  );
  expect(task).toBeDefined();

  const chats = (await app.json<ChatSummary[]>("/api/chats")).data;
  const chat = chats.find(
    (candidate) => candidate.config.name === manifest.expected.chat,
  );
  expect(chat).toBeDefined();

  const apiKeys = (await app.json<ApiKey[]>("/api/api-keys")).data;
  const apiKey = apiKeys.find(
    (candidate) => candidate.name === manifest.expected.apiKey,
  );
  expect(apiKey).toBeDefined();

  const preference = (await app.json<{ githubUsername: string | null }>(
    "/api/preferences/github-username",
  )).data;
  expect(preference.githubUsername).toBe(manifest.expected.githubUsername);

  return {
    apiKeyId: apiKey!.id,
    chatId: chat!.config.id,
    githubUsername: preference.githubUsername!,
    taskId: task!.config.id,
    taskStatus: task!.state.status,
    workspaceId: workspace!.id,
  };
}

test("current binary upgrades and preserves public v5.4.1 state", async () => {
  application = await E2EApplication.create();
  try {
    const manifest = await restorePreviousVersionData(application);
    expect(manifest.source).toEqual({
      commit: "e6140461c471ee30ed4f919d3283c117b2605d11",
      tag: "v5.4.1",
      schemaVersion: 63,
    });

    await application.start();
    const firstSnapshot = await readUpgradeSnapshot(application, manifest);
    expect(firstSnapshot.taskStatus).toBe("draft");

    const workspace = (await application.json<Workspace>(
      `/api/workspaces/${firstSnapshot.workspaceId}`,
    )).data;
    expect(workspace.scratchpad).toBe("");
    const chat = (await application.json<ChatSummary>(
      `/api/chats/${firstSnapshot.chatId}`,
    )).data;
    expect(chat.config.useChatNameAsBranch).toBe(false);

    const migratedScratchpad = "# Migrated workspace\n\nWritable after upgrade.";
    const updatedWorkspace = (await application.json<Workspace>(
      `/api/workspaces/${firstSnapshot.workspaceId}`,
      {
        method: "PUT",
        body: JSON.stringify({ scratchpad: migratedScratchpad }),
      },
    )).data;
    expect(updatedWorkspace.scratchpad).toBe(migratedScratchpad);

    await application.restart();
    expect(await readUpgradeSnapshot(application, manifest)).toEqual(
      firstSnapshot,
    );
    expect(
      (await application.json<Workspace>(
        `/api/workspaces/${firstSnapshot.workspaceId}`,
      )).data.scratchpad,
    ).toBe(migratedScratchpad);
  } catch (error) {
    const diagnostics = await application.diagnostics();
    throw new Error(
      `${String(error)}${diagnostics ? `\n${diagnostics}` : ""}`,
      { cause: error },
    );
  }
});
