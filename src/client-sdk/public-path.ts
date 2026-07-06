import {
  appAbsoluteUrl,
  appPath,
  appRequest,
  appWebSocketUrl,
  configureWebAppClient,
  getWebAppPublicBasePath,
  setWebAppPublicBasePath,
} from "@pablozaiden/webapp/web";

export { appAbsoluteUrl, appPath, appWebSocketUrl };

export function configureClientRuntime(options: {
  publicBasePath?: string | null;
  apiBaseUrl?: string | null;
  wsBaseUrl?: string | null;
} = {}): void {
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
