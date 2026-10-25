/**
 * Client-host capabilities; workspace grants still authorize individual work.
 */

import { getWebAppClientMode, type WebAppRoute } from "@pablozaiden/webapp/web";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";

export function getClankyClientCapabilities() {
  const apiBacked = getWebAppClientMode() !== "external";
  return {
    controllerAdministration: apiBacked,
    workspaceCreation: apiBacked,
    executionHosts: apiBacked,
    provisioning: apiBacked,
    voice: apiBacked,
    webPreviews: apiBacked,
    inlineVideo: apiBacked,
  };
}

export function getClankyRouteUnavailableReason(route: WebAppRoute): string | undefined {
  const capabilities = getClankyClientCapabilities();
  if (route.view === "workspace-settings"
    && (!capabilities.controllerAdministration
      || typeof route["workspaceId"] === "string" && decodeCollaborationResourceReference(route["workspaceId"]))) {
    return "Workspace settings are managed on the owning controller.";
  }
  if (!capabilities.executionHosts && (route.view === "execution-host" || route.view === "execution-host-files"
    || route.view === "code-explorer" && route["contentType"] === "execution-host"
    || route.view === "compose" && ["ssh-server", "execution-host-chat", "execution-host-terminal"].includes(String(route["kind"])))) {
    return "Execution-host administration is not available in this browser client.";
  }
  if (!capabilities.workspaceCreation && route.view === "compose" && route["kind"] === "workspace") {
    return "Connect a controller to work in its granted workspaces.";
  }
  if (!capabilities.webPreviews && route.view === "workspace-previews") {
    return "Web and VS Code previews require an API-backed client.";
  }
  if (!capabilities.provisioning && ["provisioning-job", "rebuild-workspace", "restart-workspace"].includes(route.view)) {
    return "Workspace provisioning is managed on the controller.";
  }
  if (!capabilities.controllerAdministration && route.view === "worker-update-job") {
    return "Worker updates are managed on the controller.";
  }
  return undefined;
}
