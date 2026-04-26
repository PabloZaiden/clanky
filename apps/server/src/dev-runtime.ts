export function isWebBundleReady(entries: string[]): boolean {
  return entries.includes("index.html")
    && entries.some((entry) => entry.endsWith(".js"))
    && entries.some((entry) => entry.endsWith(".css"));
}
