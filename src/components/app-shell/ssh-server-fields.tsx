import { PASSWORD_INPUT_PROPS } from "../common";
import type { SshServerFormValues } from "./ssh-server-form-utils";
import { FormGroup, TextField } from "@pablozaiden/webapp/web";

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
      <FormGroup title="Server details">
        <div className="grid gap-4 lg:grid-cols-2">
        <TextField
          id="server-name"
          label="Server name"
          value={values.name}
          onChange={(event) => onChange("name", event.target.value)}
          placeholder="Production host"
          required
          disabled={disabled}
        />
        <TextField
          id="server-address"
          label="Address"
          value={values.address}
          onChange={(event) => onChange("address", event.target.value)}
          placeholder="server.example.com"
          required
          disabled={disabled}
        />
        <TextField
          id="server-username"
          label="Username"
          value={values.username}
          onChange={(event) => onChange("username", event.target.value)}
          placeholder="ubuntu"
          required
          disabled={disabled}
        />
        <TextField
          id="server-repositories-base-path"
          label="Repositories base path"
          value={values.repositoriesBasePath}
          onChange={(event) => onChange("repositoriesBasePath", event.target.value)}
          placeholder="/workspaces"
          hint="Default base path for cloning repositories during automatic provisioning."
          disabled={disabled}
        />
        <TextField
          id="server-password"
          label="Client-only password"
          value={values.password}
          onChange={(event) => onChange("password", event.target.value)}
          placeholder="Optional"
          type="password"
          hint="Stored encrypted in this client to streamline persistent standalone sessions."
          {...PASSWORD_INPUT_PROPS}
          disabled={disabled}
        />
        </div>
      </FormGroup>
    </>
  );
}
