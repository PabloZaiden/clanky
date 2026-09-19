/**
 * Deterministic HTTP checks for the production Clanky application surface.
 *
 * This module can be used by the compiled-binary smoke runner and by CI
 * checks against an already-running Docker container. It never starts a
 * process or follows discovered URLs to another origin.
 */

const REQUEST_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 250;

type AssetKind =
  | "html-document"
  | "javascript"
  | "stylesheet"
  | "manifest"
  | "html-icon"
  | "manifest-icon";

interface RawDocumentReferences {
  javascript: string[];
  stylesheet: string[];
  manifest: string[];
  htmlIcon: string[];
}

interface HealthResponse {
  ok: true;
  version: string;
}

interface ProductionHttpSmokeOptions {
  baseUrl: string;
  signal?: AbortSignal;
  healthTimeoutMs?: number;
  ensureProcessRunning?: () => void;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error("HTTP smoke check was interrupted");
}

function normalizeBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`Invalid smoke base URL: ${value}`, { cause: error });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Smoke base URL must use HTTP or HTTPS: ${value}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Smoke base URL must not contain credentials");
  }

  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function urlForPath(baseUrl: URL, path: string): URL {
  return new URL(path, baseUrl);
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchWithTimeout(
  url: URL,
  init: RequestInit,
  parentSignal: AbortSignal | undefined,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abortFromParent = () => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
  }

  timer = setTimeout(() => {
    controller.abort(new Error(`${label} request timed out after ${String(REQUEST_TIMEOUT_MS)}ms`));
  }, REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function waitForInterval(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError(signal));
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, milliseconds));

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseHealthResponse(body: string, url: URL): HealthResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`Health response from ${url.href} was not valid JSON`, { cause: error });
  }

  if (
    !isRecord(parsed)
    || parsed["ok"] !== true
    || typeof parsed["version"] !== "string"
    || parsed["version"].trim().length === 0
  ) {
    throw new Error(`Health response from ${url.href} did not match the healthy contract`);
  }

  return {
    ok: true,
    version: parsed["version"],
  };
}

async function waitForHealth(
  baseUrl: URL,
  options: ProductionHttpSmokeOptions,
): Promise<void> {
  const healthUrl = urlForPath(baseUrl, "/api/health");
  const deadline = Date.now() + (options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
  let lastFailure = "no response received";

  while (true) {
    options.ensureProcessRunning?.();

    try {
      const response = await fetchWithTimeout(
        healthUrl,
        { headers: { accept: "application/json" } },
        options.signal,
        "Health",
      );
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}: ${body.slice(0, 500)}`);
      }

      const health = parseHealthResponse(body, healthUrl);
      console.log(`Health check passed (version ${health.version})`);
      return;
    } catch (error) {
      if (options.signal?.aborted) {
        throw abortError(options.signal);
      }
      lastFailure = formatError(error);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Application did not become healthy at ${healthUrl.href} within ${String(options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS)}ms; last failure: ${lastFailure}`,
      );
    }

    await waitForInterval(
      Math.min(HEALTH_INTERVAL_MS, remaining),
      options.signal,
    );
  }
}

function collectDocumentReferences(html: string): RawDocumentReferences {
  const references: RawDocumentReferences = {
    javascript: [],
    stylesheet: [],
    manifest: [],
    htmlIcon: [],
  };

  new HTMLRewriter()
    .on("script[src]", {
      element(element) {
        const source = element.getAttribute("src");
        if (source !== null) {
          references.javascript.push(source);
        }
      },
    })
    .on("link[href]", {
      element(element) {
        const href = element.getAttribute("href");
        if (href === null) {
          return;
        }

        const relValues = (element.getAttribute("rel") ?? "")
          .toLowerCase()
          .split(/\s+/)
          .filter((value) => value.length > 0);
        if (relValues.includes("stylesheet")) {
          references.stylesheet.push(href);
        }
        if (relValues.includes("manifest")) {
          references.manifest.push(href);
        }
        if (relValues.some((value) => value === "icon" || value.endsWith("-icon"))) {
          references.htmlIcon.push(href);
        }
      },
    })
    .transform(html);

  // @pablozaiden/webapp adds the manifest link at runtime from its generated
  // document template, so it is not present as a static link element.
  if (references.manifest.length === 0) {
    references.manifest.push("/site.webmanifest");
  }

  return references;
}

function resolveSameOriginReference(
  rawReference: string,
  baseUrl: URL,
  label: string,
): URL | undefined {
  const trimmedReference = rawReference.trim();
  if (trimmedReference.length === 0) {
    throw new Error(`${label} contained an empty resource reference`);
  }

  let resolved: URL;
  try {
    resolved = new URL(trimmedReference, baseUrl);
  } catch (error) {
    throw new Error(`Invalid ${label} reference: ${rawReference}`, { cause: error });
  }

  if (resolved.origin !== baseUrl.origin) {
    console.log(`Skipping external ${label} reference: ${rawReference}`);
    return undefined;
  }

  resolved.hash = "";
  return resolved;
}

function resolveUniqueReferences(
  rawReferences: readonly string[],
  baseUrl: URL,
  label: string,
): URL[] {
  const resolved = new Map<string, URL>();
  for (const rawReference of rawReferences) {
    const url = resolveSameOriginReference(rawReference, baseUrl, label);
    if (url !== undefined) {
      resolved.set(url.href, url);
    }
  }
  return [...resolved.values()];
}

function acceptsAssetContentType(kind: AssetKind, value: string): boolean {
  switch (kind) {
    case "html-document":
      return value === "text/html";
    case "javascript":
      return value === "application/javascript"
        || value === "application/x-javascript"
        || value === "text/javascript";
    case "stylesheet":
      return value === "text/css";
    case "manifest":
      return value === "application/manifest+json";
    case "html-icon":
    case "manifest-icon":
      return value.startsWith("image/");
  }
}

async function fetchAsset(
  url: URL,
  kind: AssetKind,
  label: string,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetchWithTimeout(
    url,
    { headers: { accept: "*/*" } },
    signal,
    label,
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${label} ${url.href} returned HTTP ${String(response.status)}: ${body.slice(0, 500)}`);
  }

  const contentType = mediaType(response);
  if (!acceptsAssetContentType(kind, contentType)) {
    await response.arrayBuffer();
    throw new Error(
      `${label} ${url.href} returned Content-Type ${contentType || "(missing)"}`,
    );
  }

  return response;
}

async function checkManifest(
  manifestUrl: URL,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetchAsset(
    manifestUrl,
    "manifest",
    "Web manifest",
    signal,
  );

  let manifest: unknown;
  try {
    manifest = await response.json() as unknown;
  } catch (error) {
    throw new Error(`Web manifest ${manifestUrl.href} was not valid JSON`, { cause: error });
  }

  if (!isRecord(manifest) || !Array.isArray(manifest["icons"]) || manifest["icons"].length === 0) {
    throw new Error(`Web manifest ${manifestUrl.href} did not contain a non-empty icons array`);
  }

  const iconUrls = new Map<string, URL>();
  for (const [index, icon] of manifest["icons"].entries()) {
    if (!isRecord(icon) || typeof icon["src"] !== "string") {
      throw new Error(`Web manifest ${manifestUrl.href} has an invalid icon at index ${String(index)}`);
    }

    const iconUrl = resolveSameOriginReference(
      icon["src"],
      manifestUrl,
      "manifest icon",
    );
    if (iconUrl !== undefined) {
      iconUrls.set(iconUrl.href, iconUrl);
    }
  }

  if (iconUrls.size === 0) {
    throw new Error(`Web manifest ${manifestUrl.href} did not contain a same-origin icon`);
  }

  for (const iconUrl of iconUrls.values()) {
    const iconResponse = await fetchAsset(
      iconUrl,
      "manifest-icon",
      "Manifest icon",
      signal,
    );
    await iconResponse.arrayBuffer();
    console.log(`Checked manifest icon: ${iconUrl.pathname}`);
  }
}

async function checkDocumentAndAssets(
  baseUrl: URL,
  signal?: AbortSignal,
): Promise<void> {
  const documentUrl = urlForPath(baseUrl, "/");
  const documentResponse = await fetchAsset(
    documentUrl,
    "html-document",
    "HTML document",
    signal,
  );
  if (mediaType(documentResponse) !== "text/html") {
    throw new Error(`HTML document ${documentUrl.href} did not return text/html`);
  }

  const html = await documentResponse.text();
  let references: RawDocumentReferences;
  try {
    references = collectDocumentReferences(html);
  } catch (error) {
    throw new Error(`Unable to parse HTML document ${documentUrl.href}`, { cause: error });
  }

  const javascriptUrls = resolveUniqueReferences(
    references.javascript,
    documentUrl,
    "JavaScript",
  );
  const stylesheetUrls = resolveUniqueReferences(
    references.stylesheet,
    documentUrl,
    "stylesheet",
  );
  const manifestUrls = resolveUniqueReferences(
    references.manifest,
    documentUrl,
    "web manifest",
  );
  const htmlIconUrls = resolveUniqueReferences(
    references.htmlIcon,
    documentUrl,
    "HTML icon",
  );

  if (javascriptUrls.length === 0) {
    throw new Error("HTML document did not contain a same-origin JavaScript asset");
  }
  if (stylesheetUrls.length === 0) {
    throw new Error("HTML document did not contain a same-origin stylesheet");
  }
  if (manifestUrls.length === 0) {
    throw new Error("HTML document did not contain a same-origin web manifest");
  }
  if (htmlIconUrls.length === 0) {
    throw new Error("HTML document did not contain a same-origin icon");
  }

  for (const javascriptUrl of javascriptUrls) {
    const response = await fetchAsset(
      javascriptUrl,
      "javascript",
      "JavaScript asset",
      signal,
    );
    await response.arrayBuffer();
    console.log(`Checked JavaScript asset: ${javascriptUrl.pathname}`);
  }
  for (const stylesheetUrl of stylesheetUrls) {
    const response = await fetchAsset(
      stylesheetUrl,
      "stylesheet",
      "Stylesheet",
      signal,
    );
    await response.arrayBuffer();
    console.log(`Checked stylesheet: ${stylesheetUrl.pathname}`);
  }
  for (const htmlIconUrl of htmlIconUrls) {
    const response = await fetchAsset(
      htmlIconUrl,
      "html-icon",
      "HTML icon",
      signal,
    );
    await response.arrayBuffer();
    console.log(`Checked HTML icon: ${htmlIconUrl.pathname}`);
  }
  for (const manifestUrl of manifestUrls) {
    await checkManifest(manifestUrl, signal);
  }
}

async function checkInitialWorkspaces(
  baseUrl: URL,
  signal?: AbortSignal,
): Promise<void> {
  const url = urlForPath(baseUrl, "/api/workspaces");
  const response = await fetchWithTimeout(
    url,
    { headers: { accept: "application/json" } },
    signal,
    "Workspace list",
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Workspace list ${url.href} returned HTTP ${String(response.status)}: ${body.slice(0, 500)}`);
  }

  let workspaces: unknown;
  try {
    workspaces = JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`Workspace list ${url.href} was not valid JSON`, { cause: error });
  }
  if (!Array.isArray(workspaces) || workspaces.length !== 0) {
    throw new Error("Workspace list did not return the expected empty initial array");
  }
  console.log("Checked initial workspace API response: empty list");
}

export async function runProductionHttpSmoke(
  options: ProductionHttpSmokeOptions,
): Promise<void> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  console.log(`Checking production HTTP surface at ${baseUrl.origin}`);
  await waitForHealth(baseUrl, options);
  await checkDocumentAndAssets(baseUrl, options.signal);
  await checkInitialWorkspaces(baseUrl, options.signal);
  console.log("Production HTTP surface checks passed");
}

function parseBaseUrlArguments(args: readonly string[]): string {
  if (args.length === 2 && args[0] === "--base-url" && args[1] !== undefined) {
    return args[1];
  }
  throw new Error("Usage: bun scripts/production-smoke-http.ts --base-url URL");
}

if (import.meta.main) {
  try {
    await runProductionHttpSmoke({
      baseUrl: parseBaseUrlArguments(process.argv.slice(2)),
    });
  } catch (error) {
    console.error(`Production HTTP smoke failed: ${formatError(error)}`);
    process.exitCode = 1;
  }
}
