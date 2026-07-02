import type { SidebarNode, WebAppRoute } from "@pablozaiden/webapp/web";

export const PRIVATE_SIDEBAR_BADGE = "Private";

export type PrivateEntity = {
  isPrivate?: boolean;
};

export type PrivateSidebarNode = SidebarNode & {
  privateHidden?: boolean;
};

export function isPrivateEntity(entity: PrivateEntity | null | undefined): boolean {
  return entity?.isPrivate === true;
}

export function isEffectivelyPrivate(
  entity: PrivateEntity | null | undefined,
  ancestors: Array<PrivateEntity | null | undefined> = [],
): boolean {
  return ancestors.some(isPrivateEntity) || isPrivateEntity(entity);
}

export function shouldObscurePrivateItem(effectivePrivate: boolean, showPrivateItems: boolean): boolean {
  return effectivePrivate && !showPrivateItems;
}

export function privateRoute(route: WebAppRoute | undefined, privateHidden: boolean): WebAppRoute | undefined {
  return privateHidden ? undefined : route;
}

export function privateSidebarPresentation<T extends SidebarNode>(
  node: T,
  privateHidden: boolean,
): T & PrivateSidebarNode {
  if (!privateHidden) {
    return {
      ...node,
      privateHidden: false,
    };
  }

  return {
    ...node,
    route: undefined,
    badge: PRIVATE_SIDEBAR_BADGE,
    badgeVariant: "disabled",
    privateHidden: true,
  };
}

export function getPrivateContainerClassName(privateHidden: boolean): string {
  return privateHidden ? "clanky-private-obscured" : "";
}
