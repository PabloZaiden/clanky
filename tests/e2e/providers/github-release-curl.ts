/**
 * External curl peer routing GitHub downloads through the local release service.
 */
import { MESH_OPERATION_TIMEOUT_MS } from "../support/timeouts";

const service = process.env["CLANKY_E2E_GITHUB_RELEASE_SERVICE"];
const curl = process.env["CLANKY_E2E_REAL_CURL"];
if (!service || !curl) throw new Error("The external GitHub release peer is not configured.");
const args: string[] = [];
const prefixes: Readonly<Record<string, string>> = {
  "raw.githubusercontent.com": "raw",
  "api.github.com": "api",
  "github.com": "github",
};
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index]!;
  if (arg === "--proto") { index++; continue; }
  if (arg === "--tlsv1.2") continue;
  if (arg.startsWith("https://")) {
    const url = new URL(arg);
    const prefix = prefixes[url.hostname];
    if (!prefix) throw new Error(`Unexpected release download host: ${url.hostname}`);
    args.push(`${service}/${prefix}${url.pathname}${url.search}`);
  } else {
    args.push(arg);
  }
}
const child = Bun.spawn([curl, ...args], {
  stdin: "ignore", stdout: "inherit", stderr: "inherit",
  timeout: MESH_OPERATION_TIMEOUT_MS, killSignal: "SIGKILL",
});
process.exitCode = await child.exited;
