import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendManager } from "../../src/core/backend/backend-manager";
import {
  getImageViewToolPath,
  resolveToolCallImagePreview,
} from "../../src/core/tool-call-image-preview";
import {
  MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES,
} from "../../src/types/message-attachments";
import { TestCommandExecutor } from "../mocks/mock-executor";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3Zs7sAAAAASUVORK5CYII=";

const tempDirs: string[] = [];

afterEach(async () => {
  backendManager.resetForTesting();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("tool-call-image-preview", () => {
  test("detects image-capable view tool inputs", () => {
    expect(getImageViewToolPath("view", { path: "/tmp/screen.png" })).toBe("/tmp/screen.png");
    expect(getImageViewToolPath("read", { path: "/tmp/screen.png", view_range: [1, 20] })).toBe("/tmp/screen.png");
    expect(getImageViewToolPath("view", { filePath: "/tmp/screen.png" })).toBe("/tmp/screen.png");
    expect(getImageViewToolPath("read", { filePath: "/tmp/screen.png", offset: 1, limit: 20 })).toBe("/tmp/screen.png");
    expect(getImageViewToolPath("bash", { path: "/tmp/screen.png" })).toBeNull();
    expect(getImageViewToolPath("view", { path: "/tmp/screen.png", command: "cat" })).toBeNull();
  });

  test("resolves an inline preview for supported image files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tool-preview-"));
    tempDirs.push(directory);
    const imagePath = join(directory, "screen.png");
    await writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    const preview = await resolveToolCallImagePreview({
      workspaceId: "workspace-1",
      directory,
      path: imagePath,
      toolCallId: "tool-1",
    });

    expect(preview).not.toBeNull();
    expect(preview?.type).toBe("image_preview");
    expect(preview?.id).toMatch(/^tool-extra-[0-9a-f]+$/);
    expect(preview?.image.filename).toBe("screen.png");
    expect(preview?.image.id).toMatch(/^tool-image-[0-9a-f]+$/);
    expect(preview?.image.mimeType).toBe("image/png");
    expect(preview?.image.data.length).toBeGreaterThan(0);
    expect(preview?.sourcePath).toBe(imagePath);
  });

  test("reuses the same preview ids for the same tool call and source path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tool-preview-"));
    tempDirs.push(directory);
    const imagePath = join(directory, "screen.png");
    await writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    const firstPreview = await resolveToolCallImagePreview({
      workspaceId: "workspace-1",
      directory,
      path: imagePath,
      toolCallId: "tool-1",
    });
    const secondPreview = await resolveToolCallImagePreview({
      workspaceId: "workspace-1",
      directory,
      path: imagePath,
      toolCallId: "tool-1",
    });
    const differentToolPreview = await resolveToolCallImagePreview({
      workspaceId: "workspace-1",
      directory,
      path: imagePath,
      toolCallId: "tool-2",
    });

    expect(firstPreview?.id).toBe(secondPreview?.id);
    expect(firstPreview?.image.id).toBe(secondPreview?.image.id);
    expect(firstPreview?.id).not.toBe(differentToolPreview?.id);
  });

  test("rejects previews larger than the shared message image size limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tool-preview-"));
    tempDirs.push(directory);
    const imagePath = join(directory, "large-screen.png");
    const oversizedPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES),
    ]);
    await writeFile(imagePath, oversizedPng);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    const preview = await resolveToolCallImagePreview({
      workspaceId: "workspace-1",
      directory,
      path: imagePath,
      toolCallId: "tool-1",
    });

    expect(preview).toBeNull();
  });

  test("returns null for unsupported files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tool-preview-"));
    tempDirs.push(directory);
    const textPath = join(directory, "notes.txt");
    await writeFile(textPath, "hello");
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    const preview = await resolveToolCallImagePreview({
      workspaceId: "workspace-1",
      directory,
      path: textPath,
      toolCallId: "tool-1",
    });

    expect(preview).toBeNull();
  });
});
