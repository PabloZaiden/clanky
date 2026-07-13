export {
  runCli,
  parseCliCommand,
  parseMainCommand,
  runMain,
  type CliCommand,
  type MainCommand,
} from "./runtime";

export {
  runUpdateCommand,
  type CliUpdateDependencies,
  type UpdateCommandOptions,
} from "./update";

export {
  createCliCredentialsStore,
  getAuthorizedHeaders,
  getCliRequestAuthContext,
  getTokenErrorMessage,
  getValidatedCredentials,
  loadStoredCliCredentials,
  normalizeBaseUrlValue,
  normalizeCookieHeaderValue,
  refreshStoredCredentials,
  runAuthCommand,
  runStatusCommand,
  saveStoredCliCredentials,
  type AuthCommandOptions,
  type CliRequestAuthContext,
  type StatusCommandOptions,
  type StoredCliCredentials,
} from "./auth";

export {
  findApiEndpoint,
  formatSchema,
  getCliRouteCatalog,
  listApiEndpoints,
  normalizeApiEndpointPath,
  type ApiEndpointCatalogEntry,
} from "./api-catalog";

export {
  buildWebSocketUrl,
  connectWsCommand,
  runWsCommand,
  type CliWebSocketLike,
  type CliWsCloseResult,
  type CliWsConnection,
  type CliWsDependencies,
  type WsCommandOptions,
} from "./ws";
