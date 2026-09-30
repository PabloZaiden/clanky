/**
 * Profile-authenticated filesystem API client with replay-safe streaming.
 */

import {
  FILE_SYSTEM_MAX_METADATA_BYTES, FileSystemInfoSchema, FileSystemResultSchema, type FileSystemCommandInput,
  type FileSystemConditions, type FileSystemInfo, type FileSystemResult,
} from "../../contracts/schemas/file-system";
import {
  fetchCliApi, readCliResponseBody, resolveCliApiAuth, resolveCliWorkspace,
  responseErrorMessage, type CliApiAuth, type CliApiContext,
} from "../remote-api";
import { DavError } from "./protocol";

function requireSecureController(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("WebDAV requires HTTPS for a non-loopback Clanky server.");
  }
}

async function readFileSystemJson(response: Response): Promise<unknown> {
  if (!response.body) throw new DavError(502, "Clanky returned no filesystem response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > FILE_SYSTEM_MAX_METADATA_BYTES) throw new DavError(507, "Filesystem response size limit exceeded.");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } finally {
    try { await reader.cancel(); }
    catch {
      // An already failed source can reject cancellation; preserve its original error.
    }
    reader.releaseLock();
  }
}

export class WebDavFileClient {
  private refresh: Promise<CliApiAuth> | undefined;
  info!: FileSystemInfo;
  private constructor(
    private readonly input: CliApiContext,
    private auth: CliApiAuth,
    private readonly endpoint: string,
  ) {}

  static async connect(input: CliApiContext, workspace: string, signal?: AbortSignal): Promise<WebDavFileClient> {
    const protectedInput: CliApiContext = {
      ...input,
      validateBaseUrl: requireSecureController,
      fetchFn: Object.assign(
        (resource: Parameters<typeof fetch>[0], init?: RequestInit) => input.fetchFn(resource, { ...init, redirect: "error" }),
        { preconnect: input.fetchFn.preconnect },
      ),
    };
    const auth = await resolveCliApiAuth(protectedInput, signal);
    protectedInput.validateBaseUrl = (baseUrl: string) => {
      requireSecureController(baseUrl);
      if (new URL(baseUrl).toString().replace(/\/+$/, "") !== new URL(auth.baseUrl).toString().replace(/\/+$/, "")) {
        throw new DavError(502, "The Clanky profile target changed; restart the DAV command.");
      }
    };
    const target = await resolveCliWorkspace(protectedInput, auth, workspace, signal);
    const client = new WebDavFileClient(protectedInput, auth, `/api/workspaces/${encodeURIComponent(target.id)}/files/filesystem`);
    client.info = FileSystemInfoSchema.parse(await client.sendCommand({ operation: "info" }, signal));
    return client;
  }

  private async credentials(signal?: AbortSignal): Promise<CliApiAuth> {
    if (this.auth.source !== "device") return this.auth;
    this.refresh ??= resolveCliApiAuth(this.input, signal);
    const pending = this.refresh;
    try {
      const refreshed = await pending;
      if (refreshed.source !== "device" || refreshed.baseUrl !== this.auth.baseUrl) {
        throw new DavError(502, "Clanky device authentication is no longer available.");
      }
      this.auth = refreshed;
      return refreshed;
    } finally {
      if (this.refresh === pending) this.refresh = undefined;
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const auth = await this.credentials(init.signal ?? undefined);
    const headers = new Headers(init.headers);
    if (this.info) headers.set("x-clanky-file-target", this.info.target);
    const response = await fetchCliApi(this.input, auth, path, { ...init, headers, redirect: "error" });
    if (!response.ok) {
      const body = await readCliResponseBody(response);
      const status = response.status === 401 || response.status === 403 ? 502 : response.status;
      throw new DavError(status, responseErrorMessage(body, "Clanky filesystem request failed."));
    }
    return response;
  }

  private async sendCommand(command: FileSystemCommandInput, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(this.endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(command), signal,
    });
    return await readFileSystemJson(response);
  }

  async command(command: Exclude<FileSystemCommandInput, { operation: "info" }>, signal?: AbortSignal): Promise<FileSystemResult> {
    return FileSystemResultSchema.parse(await this.sendCommand(command, signal));
  }

  async read(path: string, method: "GET" | "HEAD", signal?: AbortSignal): Promise<Response> {
    return await this.request(`${this.endpoint}/content?${new URLSearchParams({ path })}`, { method, signal });
  }

  async write({ path, req, conditions, signal }: {
    path: string; req: Request; conditions: FileSystemConditions; signal?: AbortSignal;
  }): Promise<FileSystemResult> {
    const response = await this.request(`${this.endpoint}/content?${new URLSearchParams({ path })}`, {
      method: "PUT", headers: {
        "content-type": "application/octet-stream",
        "x-clanky-file-conditions": JSON.stringify(conditions),
      },
      body: req.body ?? new Blob([]).stream(), signal,
    });
    return FileSystemResultSchema.parse(await readFileSystemJson(response));
  }
}
