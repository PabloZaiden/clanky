import { PASSWORD_INPUT_PROPS } from "../common";
import { InlineField } from "./shell-panel";
import type { SshServerFormValues } from "./ssh-server-form-utils";

interface SshServerFieldsProps {
  values: SshServerFormValues;
  onChange: (field: keyof SshServerFormValues, value: string) => void;
  isEditing?: boolean;
  relatedSessionCount?: number;
  disabled?: boolean;
}

export function SshServerFields({
  values,
  onChange,
  isEditing = false,
  relatedSessionCount = 0,
  disabled = false,
}: SshServerFieldsProps) {
  return (
    <>
      {isEditing && relatedSessionCount > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          {relatedSessionCount} standalone session{relatedSessionCount === 1 ? "" : "s"} already using this
          {" "}server. Changes to the address, username, or base path apply to future connections and
          {" "}provisioning actions.
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <InlineField
          id="server-name"
          label="Server name"
          value={values.name}
          onChange={(value) => onChange("name", value)}
          placeholder="Production host"
          required
          disabled={disabled}
        />
        <InlineField
          id="server-address"
          label="Address"
          value={values.address}
          onChange={(value) => onChange("address", value)}
          placeholder="server.example.com"
          required
          disabled={disabled}
        />
        <InlineField
          id="server-username"
          label="Username"
          value={values.username}
          onChange={(value) => onChange("username", value)}
          placeholder="ubuntu"
          required
          disabled={disabled}
        />
        <InlineField
          id="server-repositories-base-path"
          label="Repositories base path"
          value={values.repositoriesBasePath}
          onChange={(value) => onChange("repositoriesBasePath", value)}
          placeholder="/workspaces"
          help="Default base path for cloning repositories during automatic provisioning."
          disabled={disabled}
        />
        <InlineField
          id="server-password"
          label="Client-only password"
          value={values.password}
          onChange={(value) => onChange("password", value)}
          placeholder="Optional"
          type="password"
          help="Stored encrypted in this client to streamline persistent standalone sessions."
          inputProps={PASSWORD_INPUT_PROPS}
          disabled={disabled}
        />
      </div>
    </>
  );
}

