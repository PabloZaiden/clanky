import { useState } from "react";
import { Button } from "../common";
import type { SshServer } from "@/shared";
import { ShellPanel } from "./shell-panel";
import type { ShellRoute } from "./shell-types";
import { SshServerSettingsForm } from "./ssh-server-settings-form";

interface SshServerSettingsViewProps {
  server: SshServer;
  relatedSessionCount: number;
  shellHeaderOffsetClassName: string;
  updateServer: (
    id: string,
    request?: import("@/contracts").UpdateSshServerRequest,
    password?: string,
  ) => Promise<SshServer | null>;
  deleteServer: () => Promise<boolean>;
  navigateWithinShell: (route: ShellRoute) => void;
}

export function SshServerSettingsView({
  server,
  relatedSessionCount,
  shellHeaderOffsetClassName,
  updateServer,
  deleteServer,
  navigateWithinShell,
}: SshServerSettingsViewProps) {
  const [formValid, setFormValid] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  return (
    <ShellPanel
      eyebrow="SSH server settings"
      title="SSH Server Settings"
      description={`${server.config.username}@${server.config.address}`}
      variant="compact"
      headerOffsetClassName={shellHeaderOffsetClassName}
      actions={(
        <>
          {server.config.repositoriesBasePath && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => navigateWithinShell({ view: "server-arise", serverId: server.config.id })}
            >
              Arise
            </Button>
          )}
          <Button
            type="submit"
            form="ssh-server-settings-shell-form"
            size="sm"
            loading={submitting}
            disabled={!formValid || submitting}
          >
            <span className="sm:hidden">Save</span>
            <span className="hidden sm:inline">Save Changes</span>
          </Button>
        </>
      )}
    >
      <SshServerSettingsForm
        server={server}
        relatedSessionCount={relatedSessionCount}
        formId="ssh-server-settings-shell-form"
        onSave={updateServer}
        onDeleteServer={deleteServer}
        onSaved={() => navigateWithinShell({ view: "ssh-server", serverId: server.config.id })}
        onDeleted={() => navigateWithinShell({ view: "home" })}
        onValidityChange={setFormValid}
        onSubmittingChange={setSubmitting}
      />
    </ShellPanel>
  );
}
