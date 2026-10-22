import type { SidebarNode } from "@pablozaiden/webapp/web";

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
