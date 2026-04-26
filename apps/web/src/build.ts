import twPlugin from "bun-plugin-tailwind";
import { basename } from "path";
import { rewriteBuiltIndexHtml } from "./build-index-html";

const workspaceDir = `${import.meta.dir}/..`;
const srcDir = `${workspaceDir}/src`;
const outDir = `${workspaceDir}/dist`;
const staticAssets = [
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "site.webmanifest",
];

await Bun.$`rm -rf ${outDir}`.quiet();
await Bun.$`mkdir -p ${outDir}`.quiet();

const result = await Bun.build({
  entrypoints: [`${srcDir}/frontend.tsx`],
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

const jsOutput = result.outputs.find((output) => output.path.endsWith(".js") && !output.path.endsWith(".js.map"));
if (!jsOutput) {
  throw new Error("Web build did not emit a JavaScript entrypoint.");
}

const cssOutput = result.outputs.find((output) => output.path.endsWith(".css"));
const sourceIndexHtml = await Bun.file(`${srcDir}/index.html`).text();
const indexHtml = rewriteBuiltIndexHtml(sourceIndexHtml, {
  entryScriptFileName: basename(jsOutput.path),
  stylesheetFileName: cssOutput ? basename(cssOutput.path) : undefined,
});

await Bun.write(`${outDir}/index.html`, indexHtml);

for (const asset of staticAssets) {
  await Bun.write(`${outDir}/${asset}`, Bun.file(`${srcDir}/${asset}`));
}
