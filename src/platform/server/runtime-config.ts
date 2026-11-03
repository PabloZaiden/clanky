import {
  isTruthyEnv,
  readRuntimeConfig as readCoreRuntimeConfig,
  readWebAppConfig,
  safeRuntimeConfig as safeCoreRuntimeConfig,
  webAppConfigPath,
  type RuntimeConfig as CoreRuntimeConfig,
} from "@pablozaiden/webapp/server";

export * from "@pablozaiden/webapp/server";

export interface RuntimeConfig extends CoreRuntimeConfig {
  passkeyDisabled: boolean;
  authIssuer?: string;
}

export function readRuntimeConfig(input: Parameters<typeof readCoreRuntimeConfig>[0]): RuntimeConfig {
  const config = readCoreRuntimeConfig(input);
  const persisted = readWebAppConfig(config.dataDir);
  const environment = input.environment ?? process.env;
  return {
    ...config,
    host: environment[`${config.envPrefix}_HOST`]?.trim() ? config.host : persisted.server?.host ?? config.host,
    port: environment[`${config.envPrefix}_PORT`]?.trim() ? config.port : persisted.server?.port ?? config.port,
    configPath: webAppConfigPath(config.dataDir),
    developmentSourcePath: persisted.development?.sourcePath,
    passkeyDisabled: isTruthyEnv(environment[`${config.envPrefix}_DISABLE_PASSKEY`]),
    authIssuer: environment[`${config.envPrefix}_AUTH_ISSUER`]?.trim() || undefined,
  };
}

export function safeRuntimeConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    ...safeCoreRuntimeConfig(config),
    passkeyDisabled: config.passkeyDisabled,
    authIssuer: config.authIssuer,
    configPath: config.configPath,
    developmentSourcePath: config.developmentSourcePath,
  };
}
