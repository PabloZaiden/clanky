import twPlugin from "bun-plugin-tailwind";

const workspaceDir = `${import.meta.dir}/..`;
const sharedSrcDir = `${workspaceDir}/../../src`;
const outDir = `${workspaceDir}/dist`;
const staticAssets = [
  "apple-touch-icon.png",
  "apple-touch-icon-57x57.png",
  "apple-touch-icon-72x72.png",
  "apple-touch-icon-76x76.png",
  "apple-touch-icon-114x114.png",
  "apple-touch-icon-120x120.png",
  "apple-touch-icon-144x144.png",
  "apple-touch-icon-152x152.png",
  "apple-touch-icon-167x167.png",
  "apple-touch-icon-180x180.png",
  "favicon-96x96.png",
  "favicon.ico",
  "favicon.svg",
  "logo.png",
  "site.webmanifest",
  "web-app-manifest-192x192.png",
  "web-app-manifest-512x512.png",
];

await Bun.$`rm -rf ${outDir}`.quiet();
await Bun.$`mkdir -p ${outDir}`.quiet();

const result = await Bun.build({
  entrypoints: [`${sharedSrcDir}/index.html`],
  outdir: outDir,
  minify: true,
  sourcemap: "external",
  target: "browser",
  plugins: [twPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const asset of staticAssets) {
  await Bun.write(`${outDir}/${asset}`, Bun.file(`${sharedSrcDir}/${asset}`));
}
