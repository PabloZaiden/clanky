import { Select } from "@pablozaiden/webapp/web";
import type { WorkerUpdateMode } from "@/shared/worker-update";

export function WorkerChannelSelect({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  value: WorkerUpdateMode | undefined;
  onChange: (value: WorkerUpdateMode) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      id={id}
      aria-label="Update channel"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value as WorkerUpdateMode)}
      disabled={disabled}
    >
      {value === undefined ? <option value="" disabled>Loading...</option> : null}
      <option value="default">Default</option>
      <option value="stable">Stable</option>
      <option value="latest">Latest</option>
    </Select>
  );
}
