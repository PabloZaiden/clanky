import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { ErrorState, FormGroup, TextField, useHeaderActions, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared/workspace";
import { isWorkspaceMeshExecutionHostRef } from "@/shared/execution-host";
import type { ProvisioningJobMode } from "@/shared/provisioning";
import { useState } from "react";
import type { WorkerUpdateMode } from "@/shared/worker-update";
import { WorkerChannelSelect } from "../worker-channel-select";

interface RebuildWorkspaceViewProps {
  mode: Extract<ProvisioningJobMode, "rebuild" | "restart">;
  workspace: Workspace;
  provisioning: UseProvisioningJobResult;
  navigateWithinShell: (route: WebAppRoute) => void;
}

export function RebuildWorkspaceView({
  mode,
  workspace,
  provisioning,
  navigateWithinShell,
}: RebuildWorkspaceViewProps) {
  const [channel, setChannel] = useState<WorkerUpdateMode>("default");
  const actionLabel = mode === "restart" ? "Restart" : "Rebuild";
  const actionLabelLower = actionLabel.toLowerCase();
  const formId = `${mode}-workspace-form`;

  const executionHost = (
    workspace.provisioningHostBinding ?? workspace.executionHostBinding
  ).host;
  const isDedicatedWorkerWorkspace = isWorkspaceMeshExecutionHostRef(workspace.executionHostBinding.host);

  async function handleStartWorkspaceAction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const snapshot = await provisioning.startJob({
      name: workspace.name,
      executionHost,
      repoUrl: workspace.repoUrl ?? "",
      basePath: workspace.basePath ?? "",
      devcontainerSubpath: workspace.devcontainerSubpath ?? null,
      devboxTemplate: null,
      provider: workspace.serverSettings.agent.provider,
      adapter: workspace.serverSettings.agent.adapter,
      mode,
      targetDirectory: workspace.sourceDirectory ?? null,
      workspaceId: workspace.id,
      ...(isDedicatedWorkerWorkspace ? { channel } : {}),
    });

    if (snapshot) {
      navigateWithinShell({
        view: "provisioning-job",
        provisioningJobId: snapshot.job.config.id,
        returnView: "workspace",
        returnId: workspace.id,
      });
    }
  }

  const headerActions = [{
    id: "start-workspace-action",
    label: actionLabel,
    form: formId,
    loading: provisioning.starting,
  }];
  useHeaderActions({ primary: headerActions });

  return (
    <div className="space-y-6">
      <form
          id={formId}
          className="space-y-6"
          onSubmit={(event) => void handleStartWorkspaceAction(event)}
        >
          <FormGroup title={`${actionLabel} details`}>
            <div className="space-y-4">
            <TextField
              id={`${mode}-workspace-name`}
              label="Workspace name"
              value={workspace.name}
              disabled
            />

            <TextField
              id={`${mode}-repo-url`}
              label="Git repository URL"
              value={workspace.repoUrl ?? ""}
              disabled
            />

            <TextField
              id={`${mode}-base-path`}
              label="Remote base path"
              value={workspace.basePath ?? ""}
              disabled
            />

            <TextField
              id={`${mode}-source-directory`}
              label="Source directory"
              value={workspace.sourceDirectory ?? ""}
              disabled
            />

            <TextField
              id={`${mode}-adapter`}
              label="Adapter"
              value={workspace.serverSettings.agent.adapter}
              disabled
            />

            <TextField
              id={`${mode}-provider`}
              label="Harness"
              value={workspace.serverSettings.agent.provider}
              disabled
            />

            <TextField
              id={`${mode}-devcontainer-subpath`}
              label="Devcontainer variant"
              value={workspace.devcontainerSubpath ?? ""}
              disabled
            />

            </div>
          </FormGroup>

          {isDedicatedWorkerWorkspace && (
            <FormGroup title="Advanced options">
              <WorkerChannelSelect
                id={`${mode}-clanky-channel`}
                value={channel}
                onChange={setChannel}
                disabled={provisioning.starting}
              />
            </FormGroup>
          )}

          {provisioning.error && (
            <ErrorState title={`Unable to ${actionLabelLower} workspace`} description={provisioning.error} />
          )}
      </form>
    </div>
  );
}
