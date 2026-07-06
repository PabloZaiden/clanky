import { buildWebAppBinary, getBunCompileTargetFromArgs } from "@pablozaiden/webapp/build";
import { buildNoVncVendor } from "../scripts/novnc-vendor";

await buildNoVncVendor();

const target = getBunCompileTargetFromArgs();
const releaseTarget = target?.startsWith("bun-") ? target.slice("bun-".length) : target;
const outfile = releaseTarget ? `dist/clanky-${releaseTarget}` : "dist/clanky";

await buildWebAppBinary({
  entrypoint: "src/index.ts",
  outfile,
  target,
  web: {
    entry: "./frontend.tsx",
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
