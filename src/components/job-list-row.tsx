import { memo, type ComponentProps } from "react";
import { DataListRow, DateTimeValue } from "@pablozaiden/webapp/web";
import { StatusBadge } from "./common";

export const JobListRow = memo(function JobListRow({ title, timestamp, exitCode, description, status, statusVariant, onClick }: {
  title: string;
  timestamp?: string;
  exitCode?: number;
  description?: string;
  status: string;
  statusVariant: ComponentProps<typeof StatusBadge>["variant"];
  onClick?: () => void;
}) {
  return <DataListRow
    title={title}
    description={description}
    meta={timestamp || exitCode !== undefined ? <>
      {timestamp ? <DateTimeValue value={timestamp} /> : null}
      {timestamp && exitCode !== undefined ? " · " : null}
      {exitCode !== undefined ? `Exit code ${exitCode}` : null}
    </> : undefined}
    metaPlacement="inline"
    badge={<StatusBadge variant={statusVariant}>{status}</StatusBadge>}
    onClick={onClick}
  />;
});
