/**
 * Stable local-language selection and verified-download data-safety contracts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { detectPiperLanguage } from "../../src/core/piper-tts";
import {
  downloadVerifiedAsset,
  type PiperFileAsset,
} from "../../src/core/piper-assets";

describe("local Piper speech", () => {
  let server: Server<unknown> | null = null;
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    server?.stop();
    server = null;
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  test("selects Spanish and English locally and falls back to Argentina Spanish", () => {
    expect(
      detectPiperLanguage("La respuesta quedó lista y solo falta revisarla."),
    ).toBe("es");
    expect(
      detectPiperLanguage("The response is ready and only needs a final review."),
    ).toBe("en");
    expect(detectPiperLanguage("OK")).toBe("es");
  });

  test("installs only checksum-verified asset data and removes failed downloads", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "clanky-piper-assets-"));
    const expectedContent = new TextEncoder().encode("verified voice model config");
    const corruptedContent = expectedContent.slice();
    corruptedContent[0] = corruptedContent[0]! ^ 1;
    let servedContent = expectedContent;
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(servedContent),
    });
    const destination = join(temporaryDirectory, "voice", "model.json");
    const asset: PiperFileAsset = {
      url: `${server.url}model.json`,
      size: expectedContent.byteLength,
      sha256: createHash("sha256").update(expectedContent).digest("hex"),
    };

    await downloadVerifiedAsset(asset, destination);
    expect(await Bun.file(destination).text()).toBe("verified voice model config");

    servedContent = corruptedContent;
    const corruptedDestination = join(temporaryDirectory, "voice", "corrupted-model.json");
    await expect(downloadVerifiedAsset(asset, corruptedDestination)).rejects.toMatchObject({
      code: "voice_piper_download_failed",
    });
    expect(await Bun.file(corruptedDestination).exists()).toBe(false);
    expect(await readdir(join(temporaryDirectory, "voice"))).toEqual(["model.json"]);
  });
});
