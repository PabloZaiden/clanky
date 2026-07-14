import type { ProvisioningEvent, ProvisioningJob, ProvisioningJobSnapshot, PublicProvisioningJob, PublicProvisioningJobSnapshot, PublicServerSettings, PublicWorkspace, ServerSettings, Workspace } from "@/shared";

export function parseSensitiveFlag(value: string | null | undefined): boolean {
  return value === "true";
}

export function shouldIncludeSensitiveData(req: Request): boolean {
  return parseSensitiveFlag(new URL(req.url).searchParams.get("sensitive"));
}

export function sanitizeServerSettings(settings: ServerSettings): PublicServerSettings {
  if (settings.agent.transport === "stdio") {
    return {
      agent: settings.agent,
    };
  }

  const {
    password: _password,
    identityFile: _identityFile,
    ...publicAgentSettings
  } = settings.agent;

  return {
    agent: publicAgentSettings,
  };
}

export function sanitizeWorkspace(workspace: Workspace): PublicWorkspace {
  return {
    ...workspace,
    serverSettings: sanitizeServerSettings(workspace.serverSettings),
  };
}

export function sanitizeProvisioningJob(job: ProvisioningJob): PublicProvisioningJob {
  return {
    ...job,
    state: {
      ...job.state,
      ...(job.state.serverSettings
        ? { serverSettings: sanitizeServerSettings(job.state.serverSettings) }
        : {}),
    },
  };
}

export function sanitizeProvisioningSnapshot(
  snapshot: ProvisioningJobSnapshot,
): PublicProvisioningJobSnapshot {
  return {
    ...snapshot,
    job: sanitizeProvisioningJob(snapshot.job),
    ...(snapshot.workspace ? { workspace: sanitizeWorkspace(snapshot.workspace) } : {}),
  };
}

export function sanitizeProvisioningEvent(event: ProvisioningEvent): ProvisioningEvent {
  switch (event.type) {
    case "provisioning.started":
    case "provisioning.step":
    case "provisioning.completed":
    case "provisioning.failed":
    case "provisioning.cancelled":
      return {
        ...event,
        job: sanitizeProvisioningJob(event.job),
      };
    case "provisioning.output":
      return event;
  }
}
