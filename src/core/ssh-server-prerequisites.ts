/**
 * Remote prerequisite checks for standalone SSH servers.
 */

import type {
  SshServerConfig,
  SshServerPrerequisiteCheck,
  SshServerPrerequisiteReport,
  SshServerPrerequisiteStatus,
} from "../types";
import type { CommandExecutor } from "./command-executor";
import { buildPersistentSessionBackendInstallHint } from "./ssh-persistent-session";

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
      createCheck(
        "devbox",
        "devbox",
        server.repositoriesBasePath?.trim() ? "unknown" : "not_applicable",
        server.repositoriesBasePath?.trim()
          ? unavailableAfterConnectionFailureDetail("devbox")
          : "Automatic provisioning is disabled for this server because no repositories base path is configured.",
        ["Automatic provisioning", "devbox arise"],
      ),
    ];

    return {
      serverId: server.id,
      checkedAt,
      summary: buildSummary(checks),
      checks,
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
  const devboxCheck = server.repositoriesBasePath?.trim()
    ? await runCommandProbe(
      executor,
      "devbox",
      "devbox",
      "devbox",
      ["Automatic provisioning", "devbox arise"],
      "Install devbox and ensure it is available on PATH before using automatic provisioning or devbox arise.",
    )
    : createCheck(
      "devbox",
      "devbox",
      "not_applicable",
      "Automatic provisioning is disabled for this server because no repositories base path is configured.",
      ["Automatic provisioning", "devbox arise"],
    );

  const checks: SshServerPrerequisiteCheck[] = [
    createCheck(
      "ssh_connection",
      "SSH connectivity",
      "available",
      "Ralpher can connect to this host and execute remote commands.",
      connectionUses,
    ),
    bashCheck,
    dtachCheck,
    devboxCheck,
  ];

  return {
    serverId: server.id,
    checkedAt,
    summary: buildSummary(checks),
    checks,
  };
}
