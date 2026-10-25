import {
  appAbsoluteUrl,
  appDuplexConnection,
  appPath,
  appRequest,
  appResourceUrl,
  appSaveResource,
  appWebSocketConnection,
  appWebSocketUrl,
  configureWebAppClient,
  getWebAppPublicBasePath,
  setWebAppPublicBasePath,
} from "@pablozaiden/webapp/web";

export { appAbsoluteUrl, appDuplexConnection, appPath, appResourceUrl, appSaveResource, appWebSocketConnection, appWebSocketUrl };

export function configureClientRuntime(options: Parameters<typeof configureWebAppClient>[0] = {}): void {
  configureWebAppClient(options);
}

export function setConfiguredPublicBasePath(basePath?: string | null): void {
  setWebAppPublicBasePath(basePath);
}

export function getConfiguredPublicBasePath(): string {
  return getWebAppPublicBasePath();
}

export async function appFetch(path: string, init?: RequestInit): Promise<Response> {
  return await appRequest(path, init);
}
