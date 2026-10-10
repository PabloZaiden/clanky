/**
 * Compiled-binary application harness for black-box E2E scenarios.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  currentEnvironment,
  findFreeLoopbackPort,
  readProcessDiagnostics,
  requireCommand,
  startManagedProcess,
  stopManagedProcess,
  waitForHttp,
  type CommandResult,
  type ManagedProcess,
} from "./process";
import { operationSignal } from "./timeouts";
import {
  installExternalAcpProvider,
  installExternalGitHubProvider,
} from "./provider";

const ROOT_DIR = resolve(import.meta.dir, "../../..");
const BINARY_PATH = resolve(ROOT_DIR, "dist", "clanky");

export interface ApplicationRequestOptions extends RequestInit {
  apiKey?: string;
  includeOrigin?: boolean;
}

export interface JsonResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export class E2EApplication {
  readonly runDirectory: string;
  readonly dataDirectory: string;
  readonly homeDirectory: string;
  readonly providerBinDirectory: string;
  readonly logsDirectory: string;
  private server: ManagedProcess | null = null;
  private disablePasskey = true;
  private requestHostname = "127.0.0.1";
  private port = 0;

  private constructor(runDirectory: string) {
    this.runDirectory = runDirectory;
    this.dataDirectory = join(runDirectory, "data");
    this.homeDirectory = join(runDirectory, "home");
    this.providerBinDirectory = join(runDirectory, "bin");
    this.logsDirectory = join(runDirectory, "logs");
  }

  static async create(): Promise<E2EApplication> {
    const runDirectory = await mkdtemp(join(tmpdir(), "clanky-e2e-"));
    const application = new E2EApplication(runDirectory);
    await Promise.all([
      mkdir(application.dataDirectory, { recursive: true, mode: 0o700 }),
      mkdir(application.homeDirectory, { recursive: true, mode: 0o700 }),
      mkdir(application.providerBinDirectory, { recursive: true, mode: 0o700 }),
      mkdir(application.logsDirectory, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      installExternalAcpProvider(application.providerBinDirectory),
      installExternalGitHubProvider(application.providerBinDirectory),
    ]);
    return application;
  }

  get baseUrl(): string {
    if (this.port === 0) {
      throw new Error("Application has not been started");
    }
    return `http://${this.requestHostname}:${String(this.port)}`;
  }

  get isRunning(): boolean {
    return this.server !== null && this.server.child.exitCode === null;
  }

  async start(options: {
    disablePasskey?: boolean;
    env?: Record<string, string>;
    requestHostname?: string;
  } = {}): Promise<void> {
    if (this.server !== null) {
      throw new Error("Application is already started");
    }
    this.disablePasskey = options.disablePasskey ?? true;
    this.requestHostname = options.requestHostname ?? this.requestHostname;
    this.port = await findFreeLoopbackPort();
    const stdoutPath = join(this.logsDirectory, `server-${String(this.port)}.stdout.log`);
    const stderrPath = join(this.logsDirectory, `server-${String(this.port)}.stderr.log`);
    const environment = currentEnvironment({
      CLANKY_DATA_DIR: this.dataDirectory,
      CLANKY_DISABLE_PASSKEY: this.disablePasskey ? "true" : undefined,
      CLANKY_HOST: "127.0.0.1",
      CLANKY_PORT: String(this.port),
      CLANKY_LOG_LEVEL: "warn",
      HOME: this.homeDirectory,
      NODE_ENV: "production",
      PATH: `${this.providerBinDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
      ...options.env,
    });
    this.server = startManagedProcess(
      [BINARY_PATH, "serve"],
      {
        cwd: ROOT_DIR,
        env: environment,
        stdoutPath,
        stderrPath,
      },
    );
    try {
      await waitForHttp(`${this.baseUrl}/api/health`, this.server);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async restart(options: {
    disablePasskey?: boolean;
    env?: Record<string, string>;
    requestHostname?: string;
  } = {}): Promise<void> {
    await this.stop();
    await this.start({
      disablePasskey: options.disablePasskey ?? this.disablePasskey,
      env: options.env,
      requestHostname: options.requestHostname ?? this.requestHostname,
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await stopManagedProcess(server);
    }
  }

  async cleanup(): Promise<void> {
    await this.stop();
    await rm(this.runDirectory, { recursive: true, force: true });
  }

  async diagnostics(): Promise<string> {
    if (this.server !== null) {
      return await readProcessDiagnostics(this.server);
    }
    const entries = await Array.fromAsync(new Bun.Glob("server-*.{stdout,stderr}.log").scan(this.logsDirectory));
    const sections: string[] = [];
    for (const entry of entries.sort()) {
      const path = join(this.logsDirectory, entry);
      const contents = (await Bun.file(path).text()).trim();
      if (contents.length > 0) {
        sections.push(`${entry}:\n${contents}`);
      }
    }
    return sections.join("\n");
  }

  async request(path: string, options: ApplicationRequestOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    const method = options.method?.toUpperCase() ?? "GET";
    if (typeof options.body === "string" && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (options.apiKey !== undefined) {
      headers.set("authorization", `Bearer ${options.apiKey}`);
    }
    if (options.includeOrigin !== false && method !== "GET" && method !== "HEAD") {
      headers.set("origin", this.baseUrl);
    }
    const { apiKey: _apiKey, includeOrigin: _includeOrigin, ...requestOptions } = options;
    return await fetch(`${this.baseUrl}${path}`, {
      ...requestOptions,
      headers,
      signal: operationSignal(requestOptions.signal),
    });
  }

  async json<T>(
    path: string,
    options: ApplicationRequestOptions = {},
    expectedStatus = 200,
  ): Promise<JsonResponse<T>> {
    const response = await this.request(path, options);
    const text = await response.text();
    if (response.status !== expectedStatus) {
      throw new Error(
        `${options.method ?? "GET"} ${path} returned HTTP ${String(response.status)}, expected ${String(expectedStatus)}: ${text}`,
      );
    }
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`${path} returned invalid JSON: ${text}`, { cause: error });
    }
    return { status: response.status, headers: response.headers, data };
  }

  async cli(args: readonly string[], options: { apiKey?: string } = {}): Promise<CommandResult> {
    return await requireCommand(
      [BINARY_PATH, ...args],
      {
        cwd: ROOT_DIR,
        env: currentEnvironment({
          CLANKY_API_KEY: options.apiKey,
          CLANKY_BASE_URL: this.baseUrl,
          HOME: this.homeDirectory,
        }),
      },
    );
  }

  startCliProcess(
    args: readonly string[],
    options: {
      apiKey?: string;
      name: string;
    },
  ): ManagedProcess {
    const suffix = `${options.name}-${String(Date.now())}`;
    return startManagedProcess(
      [BINARY_PATH, ...args],
      {
        cwd: ROOT_DIR,
        env: currentEnvironment({
          CLANKY_API_KEY: options.apiKey,
          CLANKY_BASE_URL: this.baseUrl,
          HOME: this.homeDirectory,
        }),
        stdoutPath: join(this.logsDirectory, `${suffix}.stdout.log`),
        stderrPath: join(this.logsDirectory, `${suffix}.stderr.log`),
      },
    );
  }
}
