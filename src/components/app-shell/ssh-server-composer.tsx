import { useEffect, useId, useState, type FormEvent } from "react";
import { useToast } from "../../hooks";
import type { CreateSshServerRequest, SshServer, UpdateSshServerRequest } from "../../types";
import { Badge, Button, PASSWORD_INPUT_PROPS } from "../common";
import type { ShellRoute } from "./shell-types";
import { ShellPanel, InlineField } from "./shell-panel";

interface SshServerComposerProps {
  headerOffsetClassName?: string;
  initialServer?: SshServer | null;
  relatedSessionCount?: number;
  onCancel: () => void;
  onNavigate: (route: ShellRoute) => void;
  onCreateServer: (request: CreateSshServerRequest, password?: string) => Promise<SshServer | null>;
  onUpdateServer: (id: string, request?: UpdateSshServerRequest, password?: string) => Promise<SshServer | null>;
}

export function SshServerComposer({
  headerOffsetClassName,
  initialServer,
  relatedSessionCount = 0,
  onCancel,
  onNavigate,
  onCreateServer,
  onUpdateServer,
}: SshServerComposerProps) {
  const toast = useToast();
  const formId = useId();
  const isEditing = Boolean(initialServer);
  const [name, setName] = useState(initialServer?.config.name ?? "");
  const [address, setAddress] = useState(initialServer?.config.address ?? "");
  const [username, setUsername] = useState(initialServer?.config.username ?? "");
  const [repositoriesBasePath, setRepositoriesBasePath] = useState(initialServer?.config.repositoriesBasePath ?? "");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setName(initialServer?.config.name ?? "");
    setAddress(initialServer?.config.address ?? "");
    setUsername(initialServer?.config.username ?? "");
    setRepositoriesBasePath(initialServer?.config.repositoriesBasePath ?? "");
    setPassword("");
  }, [
    initialServer?.config.id,
    initialServer?.config.name,
    initialServer?.config.address,
    initialServer?.config.username,
    initialServer?.config.repositoriesBasePath,
  ]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    const nextAddress = address.trim();
    const nextUsername = username.trim();
    const nextRepositoriesBasePath = repositoriesBasePath.trim() || undefined;
    const nextPassword = password.trim() || undefined;

    if (!nextName || !nextAddress || !nextUsername) {
      toast.error("Name, address, and username are required.");
      return;
    }

    if (initialServer) {
      const hasChanges =
        nextName !== initialServer.config.name
        || nextAddress !== initialServer.config.address
        || nextUsername !== initialServer.config.username
        || nextRepositoriesBasePath !== initialServer.config.repositoriesBasePath
        || Boolean(nextPassword);

      if (!hasChanges) {
        toast.success("SSH server is already up to date.");
        onNavigate({ view: "ssh-server", serverId: initialServer.config.id });
        return;
      }
    }

    setSubmitting(true);
    try {
      const server = initialServer
        ? await onUpdateServer(
          initialServer.config.id,
          (() => {
            const patch = {
              ...(nextName !== initialServer.config.name ? { name: nextName } : {}),
              ...(nextAddress !== initialServer.config.address ? { address: nextAddress } : {}),
              ...(nextUsername !== initialServer.config.username ? { username: nextUsername } : {}),
              ...(nextRepositoriesBasePath !== initialServer.config.repositoriesBasePath
                ? { repositoriesBasePath: nextRepositoriesBasePath ?? null }
                : {}),
            };
            return Object.keys(patch).length > 0 ? patch : undefined;
          })(),
          nextPassword,
        )
        : await onCreateServer(
          {
            name: nextName,
            address: nextAddress,
            username: nextUsername,
            repositoriesBasePath: nextRepositoriesBasePath,
          },
          nextPassword,
        );

      if (!server) {
        toast.error(initialServer ? "Failed to update SSH server" : "Failed to create SSH server");
        return;
      }
      onNavigate({ view: "ssh-server", serverId: server.config.id });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ShellPanel
      eyebrow="SSH server"
      title={isEditing ? `Edit ${initialServer?.config.name ?? "SSH server"}` : "Register a standalone SSH server"}
      description={isEditing ? "Update the saved host metadata and optional client-only password." : undefined}
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
      badges={(
        <Badge variant="info" size="sm">Standalone SSH</Badge>
      )}
      actions={(
        <>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" loading={submitting}>
            {isEditing ? "Save Changes" : "Create SSH Server"}
          </Button>
        </>
      )}
    >
      <form id={formId} className="space-y-6" onSubmit={(event) => void handleSubmit(event)}>
        {isEditing && relatedSessionCount > 0 && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
            {relatedSessionCount} standalone session{relatedSessionCount === 1 ? "" : "s"} already using this server.
            Changes to the address, username, or base path apply to future connections and provisioning actions.
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          <InlineField id="server-name" label="Server name" value={name} onChange={setName} placeholder="Production host" required />
          <InlineField id="server-address" label="Address" value={address} onChange={setAddress} placeholder="server.example.com" required />
          <InlineField id="server-username" label="Username" value={username} onChange={setUsername} placeholder="ubuntu" required />
          <InlineField
            id="server-repositories-base-path"
            label="Repositories base path"
            value={repositoriesBasePath}
            onChange={setRepositoriesBasePath}
            placeholder="/workspaces"
            help="Default base path for cloning repositories during automatic provisioning."
          />
          <InlineField
            id="server-password"
            label="Client-only password"
            value={password}
            onChange={setPassword}
            placeholder="Optional"
            type="password"
            help="Stored encrypted in this client to streamline persistent standalone sessions."
            inputProps={PASSWORD_INPUT_PROPS}
          />
        </div>
      </form>
    </ShellPanel>
  );
}
