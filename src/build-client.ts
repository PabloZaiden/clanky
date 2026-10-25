import { buildWebAppClient } from "@pablozaiden/webapp/build";
import { CLANKY_WEB_OPTIONS } from "./web-client-options";
import { writeClientOperationCatalog } from "./client-operation-catalog";

export async function buildClient() {
  const mode = process.env["CLANKY_CLIENT_MODE"];
  if (mode !== undefined && mode !== "remote" && mode !== "external") {
    throw new Error("CLANKY_CLIENT_MODE must be remote or external.");
  }
  await writeClientOperationCatalog({ isolated: true });
  return await buildWebAppClient({
    ...CLANKY_WEB_OPTIONS,
    appName: "Clanky",
    outdir: "dist/client",
    apiBaseUrl: process.env["CLANKY_CLIENT_API_URL"],
    clientMode: mode,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
}

if (import.meta.main) {
  await buildClient();
}
