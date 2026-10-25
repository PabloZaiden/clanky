import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebAppDocumentConfig } from "@pablozaiden/webapp/server";
import { CLIENT_OPERATION_CATALOG_FILE, CLIENT_OPERATION_CATALOG_PATH } from "./client-operation-catalog";
import appleTouchIconPath from "./apple-touch-icon.png" with { type: "file" };
import faviconPath from "./favicon.svg" with { type: "file" };
import manifestIcon192Path from "./web-app-manifest-192x192.png" with { type: "file" };
import manifestIcon512Path from "./web-app-manifest-512x512.png" with { type: "file" };

export const CLANKY_WEB_OPTIONS = {
  entry: fileURLToPath(new URL("./frontend.tsx", import.meta.url)),
  icons: {
    favicon: { src: faviconPath, sizes: "any", type: "image/svg+xml" },
    appleTouch: { src: appleTouchIconPath, sizes: "180x180", type: "image/png" },
    manifest: [
      { src: manifestIcon192Path, sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: manifestIcon512Path, sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  },
  // Standalone binaries serve the assets embedded by the shared browser build.
  assets: Bun.isStandaloneExecutable ? [] : [
    {
      src: join(dirname(Bun.resolveSync("monaco-editor/package.json", import.meta.dir)), "min", "vs"),
      path: "/webapp-assets/monaco/vs",
    },
    { src: CLIENT_OPERATION_CATALOG_FILE, path: CLIENT_OPERATION_CATALOG_PATH },
  ],
} satisfies WebAppDocumentConfig;
