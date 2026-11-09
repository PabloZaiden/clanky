import { WEB_APP_CLIENT_CONFIG_PATH } from "@pablozaiden/webapp/contracts";
import { z } from "zod";

const [pageUrl, ...extra] = process.argv.slice(2);
if (!pageUrl || extra.length) {
  throw new Error("Usage: EXPECTED_SNAPSHOTS=<json> bun scripts/verify-pages.ts page-url");
}
const base = new URL(pageUrl);
if (!["http:", "https:"].includes(base.protocol)
  || base.username || base.password || !base.pathname.endsWith("/")) {
  throw new Error("Pages verification requires an HTTP(S) directory URL without credentials.");
}
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const infoSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  version: z.string().min(1),
  update: z.object({
    manifest: z.literal("frontend-update.json"),
    bytes: z.number().int().positive(),
    sha256: hashSchema,
  }),
});
const fileSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: hashSchema,
});
const manifestSchema = z.object({
  revision: z.string(),
  version: z.string(),
  files: z.array(fileSchema),
});
const expectedJson = process.env["EXPECTED_SNAPSHOTS"];
if (!expectedJson) {
  throw new Error("Pages verification requires EXPECTED_SNAPSHOTS from the built artifact.");
}
const snapshots = z.object({ stable: infoSchema, latest: infoSchema }).parse(JSON.parse(expectedJson));
const decoder = new TextDecoder();

async function read(path: string): Promise<Uint8Array | null> {
  const url = new URL(path, base);
  url.searchParams.set("verification", String(Date.now()));
  const response = await fetch(url, {
    headers: { "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) {
    console.warn(`Waiting for Pages to serve ${path}: HTTP 404.`);
    return null;
  }
  if (!response.ok) {
    throw new Error(`Pages verification request for ${path} failed: HTTP ${response.status}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function matchesFile(path: string, bytes: Uint8Array, expected: z.infer<typeof fileSchema>): boolean {
  if (bytes.byteLength === expected.bytes
    && new Bun.CryptoHasher("sha256").update(bytes).digest("hex") === expected.sha256) {
    return true;
  }
  console.warn(`Waiting for Pages to serve the built ${path}: size or SHA-256 mismatch.`);
  return false;
}

async function matchesChannel(channel: "stable" | "latest"): Promise<boolean> {
  const expected = snapshots[channel];
  const infoBytes = await read(`${channel}/build-info.json`);
  if (!infoBytes) return false;
  const info = infoSchema.parse(JSON.parse(decoder.decode(infoBytes)));
  if (JSON.stringify(info) !== JSON.stringify(expected)) {
    console.warn(`Waiting for ${channel}: expected ${expected.version} at ${expected.revision} with manifest ${expected.update.sha256}; served ${info.version} at ${info.revision} with manifest ${info.update.sha256}.`);
    return false;
  }
  const manifestPath = `${channel}/${info.update.manifest}`;
  const manifestBytes = await read(manifestPath);
  if (!manifestBytes || !matchesFile(manifestPath, manifestBytes, {
    path: manifestPath, ...expected.update,
  })) return false;
  const manifest = manifestSchema.parse(JSON.parse(decoder.decode(manifestBytes)));
  if (manifest.revision !== expected.revision || manifest.version !== expected.version) {
    throw new Error(`The built ${channel} manifest disagrees with its snapshot metadata.`);
  }
  for (const [connection, mode] of [["api", "remote"], ["collaboration", "external"]] as const) {
    const path = `${connection}${WEB_APP_CLIENT_CONFIG_PATH}`;
    const file = manifest.files.find(file => file.path === path);
    if (!file) {
      throw new Error(`The built ${channel} manifest does not list ${path}.`);
    }
    const bytes = await read(`${channel}/${path}`);
    if (!bytes || !matchesFile(`${channel}/${path}`, bytes, file)) return false;
    const bootstrap = z.object({ mode: z.string(), version: z.string() }).parse(JSON.parse(decoder.decode(bytes)));
    if (bootstrap.mode !== mode || bootstrap.version !== expected.version) {
      throw new Error(`The built ${channel}/${path} has an inconsistent mode or version.`);
    }
  }
  return true;
}

async function matchesSite(): Promise<boolean> {
  for (const channel of ["stable", "latest"] as const) {
    if (!await matchesChannel(channel)) return false;
  }
  const root = await read("index.html");
  if (!root) return false;
  const html = decoder.decode(root);
  if (!html.includes('href="./stable/"') || !html.includes('href="./latest/"')
    || !html.includes(`Latest release: ${snapshots.stable.version}`)
    || !html.includes(`Main build: ${snapshots.latest.version}`)) {
    console.warn("Waiting for Pages to serve the built root channel chooser.");
    return false;
  }
  return true;
}

const deadline = Date.now() + 15 * 60_000;
while (!await matchesSite()) {
  if (Date.now() >= deadline) {
    throw new Error("Pages did not serve the built channels within the 15-minute propagation limit.");
  }
  await Bun.sleep(10_000);
}
console.log(`Verified published Pages: stable ${snapshots.stable.version}, latest ${snapshots.latest.version}.`);
