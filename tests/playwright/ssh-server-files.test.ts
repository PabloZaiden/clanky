import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { waitForVisible, withBrowserTest } from "./support/browser-test";

async function saveStandaloneServerPassword(serverId: string, page: import("playwright").Page): Promise<void> {
  await page.evaluate(async ({ serverId }) => {
    const response = await fetch(`/api/ssh-servers/${serverId}/public-key`);
    if (!response.ok) {
      throw new Error(`Failed to fetch public key for ${serverId}`);
    }
    const publicKey = await response.json() as {
      algorithm: "RSA-OAEP-256";
      publicKey: string;
      fingerprint: string;
      version: number;
    };

    const normalizedKey = publicKey.publicKey
      .replace("-----BEGIN PUBLIC KEY-----", "")
      .replace("-----END PUBLIC KEY-----", "")
      .replace(/\s+/g, "");
    const decodedKey = atob(normalizedKey);
    const keyBytes = new Uint8Array(decodedKey.length);
    for (let index = 0; index < decodedKey.length; index++) {
      keyBytes[index] = decodedKey.charCodeAt(index);
    }

    const importedKey = await crypto.subtle.importKey(
      "spki",
      keyBytes.buffer,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["encrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      importedKey,
      new TextEncoder().encode("super-secret"),
    );
    const encryptedBytes = new Uint8Array(ciphertext);
    let binary = "";
    for (const byte of encryptedBytes) {
      binary += String.fromCharCode(byte);
    }

    localStorage.setItem(
      `ralpher.sshServerCredential.${serverId}`,
      JSON.stringify({
        encryptedCredential: {
          algorithm: publicKey.algorithm,
          fingerprint: publicKey.fingerprint,
          version: publicKey.version,
          ciphertext: btoa(binary),
        },
        storedAt: new Date().toISOString(),
      }),
    );
  }, { serverId });
}

test("explores a standalone SSH server and changes the root to a parent directory", async () => {
  const parentRoot = await mkdtemp(join(tmpdir(), "ralpher-playwright-ssh-server-root-"));
  const configuredRoot = join(parentRoot, "project");

  try {
    await mkdir(join(configuredRoot, "src"), { recursive: true });
    await writeFile(join(configuredRoot, "src", "index.ts"), "export const value = 1;\n");
    await mkdir(join(parentRoot, "shared"), { recursive: true });
    await writeFile(join(parentRoot, "shared", "notes.txt"), "hello from parent root\n");

    await withBrowserTest(async ({ app, page }) => {
      const createResponse = await fetch(`${app.baseUrl}/api/ssh-servers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Playwright SSH Server",
          address: "127.0.0.1",
          username: "tester",
          repositoriesBasePath: configuredRoot,
        }),
      });
      expect(createResponse.status).toBe(201);
      const server = await createResponse.json() as { config: { id: string } };

      await page.goto(`${app.baseUrl}/#/code-explorer/server/${server.config.id}`);
      await saveStandaloneServerPassword(server.config.id, page);
      await page.reload();

      await waitForVisible(page.getByRole("heading", { name: "Playwright SSH Server code explorer" }));
      await waitForVisible(page.getByRole("button", { name: "src" }));
      expect(await page.getByLabel("Explorer root directory").count()).toBe(0);

      await page.getByRole("button", { name: "Change explorer root" }).click();
      await waitForVisible(page.getByLabel("Explorer root directory"));
      await page.getByLabel("Explorer root directory").fill(parentRoot);
      await page.getByRole("button", { name: "Apply changes" }).click();

      await waitForVisible(page.getByRole("button", { name: "project" }));
      await waitForVisible(page.getByRole("button", { name: "shared" }));
      await page.getByRole("button", { name: "shared" }).click();
      await waitForVisible(page.getByRole("button", { name: "notes.txt" }));
      await page.getByRole("button", { name: "notes.txt" }).click();
      await waitForVisible(page.getByText("shared/notes.txt"));
    });
  } finally {
    await rm(parentRoot, { recursive: true, force: true });
  }
});
