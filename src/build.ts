import { buildWebAppBinary, getBunCompileTargetFromArgs } from "@pablozaiden/webapp/build";
import { buildClient } from "./build-client";

const target = getBunCompileTargetFromArgs();
const releaseTarget = target?.startsWith("bun-") ? target.slice("bun-".length) : target;
const outfile = releaseTarget ? `dist/clanky-${releaseTarget}` : "dist/clanky";
// The shared webapp builder compiles one server entrypoint, so embed the worker
// bundle for standalone binaries.
const permissionWorkerBuild = await Bun.build({
  entrypoints: ["src/core/macos-worker-permissions.worker.ts"],
  target: "bun",
  format: "esm",
  minify: true,
});
if (!permissionWorkerBuild.success) {
  for (const log of permissionWorkerBuild.logs) {
    console.error(log);
  }
  throw new Error("macOS worker permission preflight build failed");
}
const permissionWorkerOutput = permissionWorkerBuild.outputs[0];
if (!permissionWorkerOutput) {
  throw new Error("macOS worker permission preflight build produced no output");
}
const permissionWorkerSource = await permissionWorkerOutput.text();

await buildWebAppBinary({
  entrypoint: "src/index.ts",
  outfile,
  target,
  web: { client: await buildClient() },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __CLANKY_MACOS_WORKER_PERMISSION_PREFLIGHT_SOURCE__: JSON.stringify(permissionWorkerSource),
  },
});
