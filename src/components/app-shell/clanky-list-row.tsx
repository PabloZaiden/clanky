import type { ComponentProps, ReactNode } from "react";
import { DataListRow } from "@pablozaiden/webapp/web";
import { getPrivateContainerClassName } from "../../lib/private-items";

export function ClankyListRow({
  title,
  description,
  descriptionClassName = "truncate",
  meta,
  metaPlacement = "side",
  badge,
  onClick,
  privateHidden = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  descriptionClassName?: string;
  meta?: ReactNode;
  metaPlacement?: ComponentProps<typeof DataListRow>["metaPlacement"];
  badge?: ReactNode;
  onClick?: () => void;
  privateHidden?: boolean;
}) {
  return (
    <DataListRow
      title={title}
      description={description}
      descriptionClassName={descriptionClassName}
      meta={meta}
      metaPlacement={metaPlacement}
      badge={badge}
      onClick={!privateHidden ? onClick : undefined}
      className={getPrivateContainerClassName(privateHidden)}
    />
  );
}
