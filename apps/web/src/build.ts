import twPlugin from "bun-plugin-tailwind";

const workspaceDir = `${import.meta.dir}/..`;
const sharedSrcDir = `${workspaceDir}/../../src`;
const outDir = `${workspaceDir}/dist`;
const staticAssets = [
  "icon-192.png",
  "icon-512.png",
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
