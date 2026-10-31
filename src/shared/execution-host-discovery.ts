/**
 * Prerequisites and Devbox templates discovered on an execution host.
 */

export interface DevboxTemplateSummary {
  name: string;
  description: string;
  source: "built-in";
  base: string;
  image: string | null;
  pinnedReference: string;
  runtimeVersion: string;
  languages: string[];
  runnerCompatible: boolean;
}

export type ExecutionHostPrerequisiteId =
  | "connection"
  | "bash"
  | "dtach"
  | "devbox"
  | "docker"
  | "devcontainer"
  | "git"
  | "gh";

export type ExecutionHostPrerequisiteStatus =
  | "available"
  | "missing"
  | "not_applicable"
  | "unknown";

export type ExecutionHostPrerequisiteSummaryStatus =
  | "ready"
  | "missing_requirements"
  | "connection_failed";

export interface ExecutionHostPrerequisiteCheck {
  id: ExecutionHostPrerequisiteId;
  label: string;
  status: ExecutionHostPrerequisiteStatus;
  details: string;
  requiredFor: string[];
  installHint?: string;
}

export interface ExecutionHostPrerequisiteReport {
  serverId: string;
  checkedAt: string;
  summary: {
    status: ExecutionHostPrerequisiteSummaryStatus;
    availableCount: number;
    missingCount: number;
    notApplicableCount: number;
    unknownCount: number;
  };
  checks: ExecutionHostPrerequisiteCheck[];
}
