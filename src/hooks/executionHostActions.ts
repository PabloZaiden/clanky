import type {
  DevboxTemplateSummary,
  ExecutionHostRef,
  ExecutionHostPrerequisiteReport,
} from "@/shared";
import { getExecutionHostSourceId } from "@/shared";
import type {
  GetDevboxTemplatesRequest,
} from "@/contracts";
import { apiRequest } from "../lib/api-client";

function executionHostApiPath(host: ExecutionHostRef): string {
  return `/api/execution-hosts/${host.kind}/${encodeURIComponent(getExecutionHostSourceId(host))}`;
}

export async function checkExecutionHostPrerequisitesApi(options: {
  executionHost: ExecutionHostRef;
}): Promise<ExecutionHostPrerequisiteReport> {
  return await apiRequest<ExecutionHostPrerequisiteReport>(
    `${executionHostApiPath(options.executionHost)}/prerequisites`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      action: "Check execution host prerequisites",
      fallbackMessage: "Failed to check execution host prerequisites",
    },
  );
}

export async function listExecutionHostDevboxTemplatesApi(options: {
  executionHost: ExecutionHostRef;
  signal?: AbortSignal;
}): Promise<DevboxTemplateSummary[]> {
  const request: GetDevboxTemplatesRequest = {};
  return await apiRequest<DevboxTemplateSummary[]>(
    `${executionHostApiPath(options.executionHost)}/devbox-templates`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: options.signal,
      action: "List Devbox templates",
      fallbackMessage: "Failed to list Devbox templates",
    },
  );
}
