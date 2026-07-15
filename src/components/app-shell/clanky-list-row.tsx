import type { ReactNode } from "react";
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
  metaPlacement?: "side" | "below";
  badge?: ReactNode;
  onClick?: () => void;
  privateHidden?: boolean;
}) {
  return (
    <DataListRow
      title={title}
      description={description}
      descriptionClassName={`mt-1 ${descriptionClassName}`.trim()}
      meta={meta}
      metaPlacement={metaPlacement}
      badge={badge}
      onClick={!privateHidden ? onClick : undefined}
      variant="card"
      className={getPrivateContainerClassName(privateHidden)}
    />
  );
}
