import {
  appAbsoluteUrl,
  appDuplexConnection,
  appPath,
  appRequest,
  appResourceUrl,
  appSaveResource,
  appWebSocketConnection,
  appWebSocketUrl,
  getWebAppPublicBasePath,
  setWebAppPublicBasePath,
} from "@pablozaiden/webapp/web";
import { configureClankyClient } from "@/platform/web/api-client";

export { appAbsoluteUrl, appDuplexConnection, appPath, appResourceUrl, appSaveResource, appWebSocketConnection, appWebSocketUrl };

export function configureClientRuntime(options: Parameters<typeof configureClankyClient>[0] = {}): void {
  configureClankyClient(options);
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
