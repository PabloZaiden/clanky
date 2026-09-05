import type { WebAppRoute } from "@pablozaiden/webapp/web";

export function getRouteString(route: WebAppRoute, key: string): string | undefined {
  const value = route[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getProvisioningReturnRoute(route: WebAppRoute): WebAppRoute {
  const returnView = getRouteString(route, "returnView");
  const returnId = getRouteString(route, "returnId");
  if (returnView === "workspace" && returnId) {
    return { view: "workspace", workspaceId: returnId };
  }
  const returnKind = getRouteString(route, "returnKind");
  if (
    returnView === "execution-host"
    && returnId
    && (returnKind === "local" || returnKind === "mesh" || returnKind === "ssh")
  ) {
    return { view: "execution-host", hostKind: returnKind, hostId: returnId };
  }
  return { view: "home" };
}
