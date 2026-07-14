/**
 * Remote prerequisite checks for standalone SSH servers.
 */

import type { SshServerConfig, SshServerPrerequisiteCheck, SshServerPrerequisiteReport, SshServerPrerequisiteStatus } from "@/shared";
import type { CommandExecutor } from "./command-executor";
import { buildPersistentSessionBackendInstallHint } from "./ssh-persistent-session";

const automaticProvisioningDisabledDetail =
  "Automatic provisioning is disabled for this server because no repositories base path is configured.";

function missingCommandDetail(command: string): string {
  return `${command} is not installed or not available on PATH on the remote host.`;
}

function unavailableAfterConnectionFailureDetail(label: string): string {
  return `Could not verify ${label} because the SSH connectivity probe failed.`;
}

function createCheck(
  id: SshServerPrerequisiteCheck["id"],
  label: string,
  status: SshServerPrerequisiteStatus,
  details: string,
  requiredFor: string[],
  installHint?: string,
): SshServerPrerequisiteCheck {
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
    SshServerPrerequisiteCheck["id"],
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
  id: SshServerPrerequisiteCheck["id"],
  label: string,
  command: string,
  requiredFor: string[],
  installHint: string,
): Promise<SshServerPrerequisiteCheck> {
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

function createAutomaticProvisioningNotApplicableChecks(): SshServerPrerequisiteCheck[] {
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

function createAutomaticProvisioningUnknownChecks(): SshServerPrerequisiteCheck[] {
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
): Promise<SshServerPrerequisiteCheck[]> {
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

function buildSummary(checks: SshServerPrerequisiteCheck[]): SshServerPrerequisiteReport["summary"] {
  const availableCount = checks.filter((check) => check.status === "available").length;
  const missingCount = checks.filter((check) => check.status === "missing").length;
  const notApplicableCount = checks.filter((check) => check.status === "not_applicable").length;
  const unknownCount = checks.filter((check) => check.status === "unknown").length;
  const sshConnection = checks.find((check) => check.id === "ssh_connection");

  let status: SshServerPrerequisiteReport["summary"]["status"] = "ready";
  if (sshConnection?.status !== "available") {
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

export async function checkSshServerPrerequisites(
  server: SshServerConfig,
  executor: CommandExecutor,
): Promise<SshServerPrerequisiteReport> {
  const checkedAt = new Date().toISOString();
  const connectionUses = ["Connecting to this SSH server"];
  const connectionProbe = await executor.exec("true", [], { cwd: "/" });

  if (!connectionProbe.success) {
    const detail = connectionProbe.stderr.trim()
      || connectionProbe.stdout.trim()
      || "Unable to execute commands over SSH.";
    const checks: SshServerPrerequisiteCheck[] = [
      createCheck(
        "ssh_connection",
        "SSH connectivity",
        "missing",
        `Failed to connect to the remote host: ${detail}`,
        connectionUses,
      ),
      createCheck(
        "bash",
        "bash",
        "unknown",
        unavailableAfterConnectionFailureDetail("bash"),
        ["Standalone SSH sessions", "Automatic provisioning", "devbox arise"],
      ),
      createCheck(
        "dtach",
        "dtach",
        "unknown",
        unavailableAfterConnectionFailureDetail("dtach"),
        ["Persistent SSH sessions"],
      ),
    ];
    const provisioningChecks = server.repositoriesBasePath?.trim()
      ? createAutomaticProvisioningUnknownChecks()
      : createAutomaticProvisioningNotApplicableChecks();
    const checksWithProvisioning: SshServerPrerequisiteCheck[] = [
      ...checks,
      ...provisioningChecks,
    ];

    return {
      serverId: server.id,
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
    ["Standalone SSH sessions", "Automatic provisioning", "devbox arise"],
    "Install bash and ensure it is available on PATH before using shell-based SSH workflows.",
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
    ["Persistent SSH sessions"],
    dtachResult.success ? undefined : buildPersistentSessionBackendInstallHint(),
  );
  const provisioningChecks = await runAutomaticProvisioningChecks(executor, server.repositoriesBasePath ?? undefined);

  const checks: SshServerPrerequisiteCheck[] = [
    createCheck(
      "ssh_connection",
      "SSH connectivity",
      "available",
      "Clanky can connect to this host and execute remote commands.",
      connectionUses,
    ),
    bashCheck,
    dtachCheck,
    ...provisioningChecks,
  ];

  return {
    serverId: server.id,
    checkedAt,
    summary: buildSummary(checks),
    checks,
  };
}
