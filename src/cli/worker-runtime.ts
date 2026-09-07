import { resolve } from "node:path";
import {
  readRuntimeConfig,
  readWebAppConfig,
  resolveAppDataDir,
  type RuntimeEnvironment,
} from "@pablozaiden/webapp/server";
import {
  resolveServeOptionValues,
} from "@pablozaiden/webapp/cli";
import { CLANKY_SERVE_OPTIONS } from "./serve-options";

export interface WorkerRuntimeConfiguration {
  dataDir: string;
  workerDirectory: string;
  workerExecutionEnabled: boolean;
  host: string;
  port: number;
}

export function resolveWorkerRuntimeConfiguration(input: {
  environment?: RuntimeEnvironment;
  cwd?: string;
} = {}): WorkerRuntimeConfiguration {
  const environment = input.environment ?? process.env;
  const dataDir = resolveAppDataDir({
    envPrefix: "CLANKY",
    appDirectoryName: ".clanky",
    environment,
  });
  const runtime = readRuntimeConfig({
    appName: "Clanky",
    envPrefix: "CLANKY",
    appDirectoryName: ".clanky",
    environment,
  });
  const persisted = readWebAppConfig(dataDir);
  const values = resolveServeOptionValues({
    definitions: CLANKY_SERVE_OPTIONS,
    envPrefix: "CLANKY",
    environment,
    persisted,
  });
  const configuredDirectory = values["worker-directory"];
  const workerDirectory = resolve(
    input.cwd ?? process.cwd(),
    typeof configuredDirectory === "string" && configuredDirectory.trim()
      ? configuredDirectory.trim()
      : ".",
  );

  return {
    dataDir,
    workerDirectory,
    workerExecutionEnabled: values["worker-execution-enabled"] !== false,
    host: runtime.host,
    port: runtime.port,
  };
}
