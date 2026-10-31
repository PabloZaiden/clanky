/**
 * Prerequisite checks for execution hosts.
 */

import type { ExecutionHostPrerequisiteCheck, ExecutionHostPrerequisiteReport, ExecutionHostPrerequisiteStatus } from "@/shared";
import type { CommandExecutor } from "./command-executor";
import { buildPersistentSessionBackendInstallHint } from "./terminal/persistent-session";

const automaticProvisioningDisabledDetail =
  "Automatic provisioning is disabled for this server because no repositories base path is configured.";

function missingCommandDetail(command: string): string {
  return `${command} is not installed or not available on PATH on the remote host.`;
}

function unavailableAfterConnectionFailureDetail(label: string): string {
  return `Could not verify ${label} because the execution host connectivity probe failed.`;
}

function createCheck(
  id: ExecutionHostPrerequisiteCheck["id"],
  label: string,
  status: ExecutionHostPrerequisiteStatus,
  details: string,
  requiredFor: string[],
  installHint?: string,
): ExecutionHostPrerequisiteCheck {
  return {
    id,
    label,
    status,
    details,
    requiredFor,
    ...(installHint ? { installHint } : {}),
  };
}

const automaticProvisioningChecks: Array<{
  id: Extract<
    ExecutionHostPrerequisiteCheck["id"],
    "devbox" | "docker" | "devcontainer" | "git" | "gh"
  >;
  label: string;
  command: string;
  requiredFor: string[];
  installHint: string;
}> = [
  {
    id: "devbox",
    label: "devbox",
    command: "devbox",
    requiredFor: ["Automatic provisioning", "devbox arise"],
    installHint: "Install devbox and ensure it is available on PATH before using automatic provisioning or devbox arise.",
  },
  {
    id: "docker",
    label: "docker",
    command: "docker",
    requiredFor: ["Automatic provisioning"],
    installHint: "Install Docker and ensure the docker CLI is available on PATH before using automatic provisioning.",
  },
  {
    id: "devcontainer",
    label: "devcontainer",
    command: "devcontainer",
    requiredFor: ["Automatic provisioning"],
    installHint: "Install the devcontainer CLI and ensure it is available on PATH before using automatic provisioning.",
  },
  {
    id: "git",
    label: "git",
    command: "git",
    requiredFor: ["Automatic provisioning"],
    installHint: "Install git and ensure it is available on PATH before using automatic provisioning.",
  },
  {
    id: "gh",
    label: "gh",
    command: "gh",
    requiredFor: ["Automatic provisioning"],
    installHint: "Install GitHub CLI (gh) and ensure it is available on PATH before using automatic provisioning.",
  },
];

async function runCommandProbe(
  executor: CommandExecutor,
  id: ExecutionHostPrerequisiteCheck["id"],
  label: string,
  command: string,
  requiredFor: string[],
  installHint: string,
): Promise<ExecutionHostPrerequisiteCheck> {
  if (id === "devbox") {
    const result = await executor.exec(command, ["--help"], { cwd: "/" });
    if (!result.success) {
      return createCheck(
        id,
        label,
        "missing",
        missingCommandDetail(command),
        requiredFor,
        installHint,
      );
    }

    return createCheck(
      id,
      label,
      "available",
      `${label} is available on the remote host.`,
      requiredFor,
    );
  }

  const result = await executor.exec("sh", ["-c", `command -v ${command} >/dev/null 2>&1`], {
    cwd: "/",
  });
  return createCheck(
    id,
    label,
    result.success ? "available" : "missing",
    result.success
      ? `${label} is available on the remote host.`
      : missingCommandDetail(command),
    requiredFor,
    result.success ? undefined : installHint,
  );
}

function createAutomaticProvisioningNotApplicableChecks(): ExecutionHostPrerequisiteCheck[] {
  return automaticProvisioningChecks.map((check) =>
    createCheck(
      check.id,
      check.label,
      "not_applicable",
      automaticProvisioningDisabledDetail,
      check.requiredFor,
    )
  );
}

function createAutomaticProvisioningUnknownChecks(): ExecutionHostPrerequisiteCheck[] {
  return automaticProvisioningChecks.map((check) =>
    createCheck(
      check.id,
      check.label,
      "unknown",
      unavailableAfterConnectionFailureDetail(check.label),
      check.requiredFor,
    )
  );
}

async function runAutomaticProvisioningChecks(
  executor: CommandExecutor,
  repositoriesBasePath?: string,
): Promise<ExecutionHostPrerequisiteCheck[]> {
  if (!repositoriesBasePath?.trim()) {
    return createAutomaticProvisioningNotApplicableChecks();
  }

  return await Promise.all(
    automaticProvisioningChecks.map((check) =>
      runCommandProbe(
        executor,
        check.id,
        check.label,
        check.command,
        check.requiredFor,
        check.installHint,
      )
    ),
  );
}

function buildSummary(checks: ExecutionHostPrerequisiteCheck[]): ExecutionHostPrerequisiteReport["summary"] {
  const availableCount = checks.filter((check) => check.status === "available").length;
  const missingCount = checks.filter((check) => check.status === "missing").length;
  const notApplicableCount = checks.filter((check) => check.status === "not_applicable").length;
  const unknownCount = checks.filter((check) => check.status === "unknown").length;
  const connection = checks.find((check) => check.id === "connection");

  let status: ExecutionHostPrerequisiteReport["summary"]["status"] = "ready";
  if (connection?.status !== "available") {
    status = "connection_failed";
  } else if (missingCount > 0 || unknownCount > 0) {
    status = "missing_requirements";
  }

  return {
    status,
    availableCount,
    missingCount,
    notApplicableCount,
    unknownCount,
  };
}

export interface ExecutionHostPrerequisiteTarget {
  targetId: string;
  connectionLabel: string;
  repositoriesBasePath: string | null;
}

export async function checkExecutionHostPrerequisites(
  target: ExecutionHostPrerequisiteTarget,
  executor: CommandExecutor,
): Promise<ExecutionHostPrerequisiteReport> {
  const checkedAt = new Date().toISOString();
  const connectionUses = [`Connecting to this ${target.connectionLabel} host`];
  const connectionProbe = await executor.exec("true", [], { cwd: "/" });

  if (!connectionProbe.success) {
    const detail = connectionProbe.stderr.trim()
      || connectionProbe.stdout.trim()
      || "Unable to execute commands on the execution host.";
    const checks: ExecutionHostPrerequisiteCheck[] = [
      createCheck(
        "connection",
        `${target.connectionLabel} connectivity`,
        "missing",
        `Failed to connect to the execution host: ${detail}`,
        connectionUses,
      ),
      createCheck(
        "bash",
        "bash",
        "unknown",
        unavailableAfterConnectionFailureDetail("bash"),
        ["Terminals", "Automatic provisioning", "devbox arise"],
      ),
      createCheck(
        "dtach",
        "dtach",
        "unknown",
        unavailableAfterConnectionFailureDetail("dtach"),
        ["Persistent terminals"],
      ),
    ];
    const provisioningChecks = target.repositoriesBasePath?.trim()
      ? createAutomaticProvisioningUnknownChecks()
      : createAutomaticProvisioningNotApplicableChecks();
    const checksWithProvisioning: ExecutionHostPrerequisiteCheck[] = [
      ...checks,
      ...provisioningChecks,
    ];

    return {
      serverId: target.targetId,
      checkedAt,
      summary: buildSummary(checksWithProvisioning),
      checks: checksWithProvisioning,
    };
  }

  const bashCheck = await runCommandProbe(
    executor,
    "bash",
    "bash",
    "bash",
    ["Terminals", "Automatic provisioning", "devbox arise"],
    "Install bash and ensure it is available on PATH before using shell-based workflows.",
  );
  const dtachResult = await executor.exec(
    "sh",
    ["-c", "command -v dtach >/dev/null 2>&1 && dtach --help >/dev/null 2>&1"],
    { cwd: "/" },
  );
  const dtachCheck = createCheck(
    "dtach",
    "dtach",
    dtachResult.success ? "available" : "missing",
    dtachResult.success
      ? "dtach is available on the remote host."
      : missingCommandDetail("dtach"),
    ["Persistent terminals"],
    dtachResult.success ? undefined : buildPersistentSessionBackendInstallHint(),
  );
  const provisioningChecks = await runAutomaticProvisioningChecks(
    executor,
    target.repositoriesBasePath ?? undefined,
  );

  const checks: ExecutionHostPrerequisiteCheck[] = [
    createCheck(
      "connection",
      `${target.connectionLabel} connectivity`,
      "available",
      "Clanky can connect to this host and execute commands.",
      connectionUses,
    ),
    bashCheck,
    dtachCheck,
    ...provisioningChecks,
  ];

  return {
    serverId: target.targetId,
    checkedAt,
    summary: buildSummary(checks),
    checks,
  };
}
