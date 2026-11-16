import { isAbsolute, join } from "node:path";
import { shellQuote } from "./provisioning/worker-assets";
import { sshAgentError } from "./ssh-agent-protocol";

export function workspaceSshAgentSocketPath(dataDirectory: string, socketDirectory?: string): string {
  return join(socketDirectory ?? join(dataDirectory, "ssh-agent"), "workspace.s");
}

export function sharedSshAgentEnvironment(socketPath: string): Record<string, string> {
  if (!isAbsolute(socketPath) || socketPath.includes("\0")) throw sshAgentError("socket_invalid", "The shared SSH-agent socket path is invalid.");
  return {
    SSH_AUTH_SOCK: socketPath,
    CLANKY_SCOPED_SSH_AUTH_SOCK: socketPath,
  };
}

export function scopedSshAgentEnvironment(socketPath: string): {
  SSH_AUTH_SOCK: string;
  GIT_SSH_VARIANT: "ssh";
  GIT_SSH_COMMAND: string;
} {
  if (!isAbsolute(socketPath) || socketPath.includes("\0")) throw sshAgentError("socket_invalid", "The scoped SSH-agent socket path is invalid.");
  return {
    SSH_AUTH_SOCK: socketPath,
    GIT_SSH_VARIANT: "ssh",
    GIT_SSH_COMMAND: [
      "ssh", "-F", "/dev/null", "-o", shellQuote(`IdentityAgent=${socketPath}`),
      "-o", "IdentityFile=none", "-o", "IdentitiesOnly=no",
      "-o", "PreferredAuthentications=publickey", "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no",
    ].join(" "),
  };
}
