import type { WebAppRoute } from "@pablozaiden/webapp/web";

export function getRouteString(route: WebAppRoute, key: string): string | undefined {
  const value = route[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
