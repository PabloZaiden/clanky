import { buildWebAppClient } from "@pablozaiden/webapp/build";
import { CLANKY_WEB_OPTIONS } from "./web-client-options";

export async function buildClient() {
  return await buildWebAppClient({
    ...CLANKY_WEB_OPTIONS,
    appName: "Clanky",
    outdir: "dist/client",
    apiBaseUrl: process.env["CLANKY_CLIENT_API_URL"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
}

if (import.meta.main) {
  await buildClient();
}
