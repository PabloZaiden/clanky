import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WEB_APP_CLIENT_CONFIG_PATH } from "@pablozaiden/webapp/contracts";
import { z } from "zod";

export async function verifyAppleFrontend(web: string, revision: string, version: string): Promise<void> {
  const hash = z.string().regex(/^[a-f0-9]{64}$/);
  const info = z.object({
    revision: z.literal(revision), version: z.literal(version),
    update: z.object({
      manifest: z.literal("frontend-update.json"), bytes: z.number().int().positive(), sha256: hash,
    }),
  }).parse(JSON.parse(await readFile(join(web, "build-info.json"), "utf8")));
  const manifestBytes = await readFile(join(web, info.update.manifest));
  if (manifestBytes.byteLength !== info.update.bytes
    || new Bun.CryptoHasher("sha256").update(manifestBytes).digest("hex") !== info.update.sha256) {
    throw new Error("The Apple frontend manifest failed integrity verification.");
  }
  const manifest = z.object({
    revision: z.literal(revision), version: z.literal(version),
    files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: hash })),
  }).parse(JSON.parse(manifestBytes.toString()));
  for (const [connection, mode] of [["api", "remote"], ["collaboration", "external"]] as const) {
    const path = `${connection}${WEB_APP_CLIENT_CONFIG_PATH}`;
    const asset = manifest.files.find((file) => file.path === path);
    const bytes = await readFile(join(web, path));
    if (!asset || bytes.byteLength !== asset.bytes
      || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== asset.sha256) {
      throw new Error(`The Apple frontend bootstrap ${path} failed integrity verification.`);
    }
    z.object({ mode: z.literal(mode), version: z.literal(version) }).parse(JSON.parse(bytes.toString()));
  }
}

if (import.meta.main) {
  const [web, revision, version, ...extra] = process.argv.slice(2);
  if (!web || !revision || !version || extra.length) {
    throw new Error("Usage: bun scripts/verify-apple-frontend.ts <web-directory> <revision> <version>");
  }
  await verifyAppleFrontend(web, revision, version);
}
