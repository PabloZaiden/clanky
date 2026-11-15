import type {
  EnvironmentTemplateSummary,
  ExecutionHostRef,
  ExecutionHostPrerequisiteReport,
} from "@/shared";
import { getExecutionHostSourceId } from "@/shared";
import type {
  GetEnvironmentTemplatesRequest,
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

export async function listExecutionHostEnvironmentTemplatesApi(options: {
  executionHost: ExecutionHostRef;
  signal?: AbortSignal;
}): Promise<EnvironmentTemplateSummary[]> {
  const request: GetEnvironmentTemplatesRequest = {};
  return await apiRequest<EnvironmentTemplateSummary[]>(
    `${executionHostApiPath(options.executionHost)}/environment-templates`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: options.signal,
      action: "List Environment templates",
      fallbackMessage: "Failed to list Environment templates",
    },
  );
}
