import type { ComponentProps, ReactNode } from "react";
import { DataListRow } from "@pablozaiden/webapp/web";
import { usePrivateItemReveal } from "../../hooks/usePrivateItemReveal";

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
  const reveal = usePrivateItemReveal(privateHidden);
  const row = (
    <DataListRow
      title={title}
      description={description}
      descriptionClassName={descriptionClassName}
      meta={meta}
      metaPlacement={metaPlacement}
      badge={badge}
      onClick={reveal.canActivate ? onClick : undefined}
      className={reveal.className}
    />
  );

  if (!privateHidden) {
    return row;
  }

  return (
    <div
      className="clanky-private-item-event-surface"
      onPointerEnter={reveal.onPointerEnter}
      onPointerLeave={reveal.onPointerLeave}
    >
      {row}
    </div>
  );
}
