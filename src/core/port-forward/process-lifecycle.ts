import type { ChildProcess } from "node:child_process";
import type { PortForward, Workspace } from "../../types";
import { buildSshProcessConfig, getSshConnectionTargetFromWorkspace } from "../ssh-connection-target";
import { LOCAL_FORWARD_HOST, STARTUP_GRACE_MS } from "./constants";

export function buildSpawnConfig(workspace: Workspace, forward: PortForward): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const sshTarget = getSshConnectionTargetFromWorkspace(workspace);
  return buildSshProcessConfig({
    target: sshTarget,
    connectionScope: workspace.directory,
    extraArgs: [
      "-N",
      "-T",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `${LOCAL_FORWARD_HOST}:${forward.config.localPort}:${forward.config.remoteHost}:${forward.config.remotePort}`,
    ],
    passwordHandling: "environment",
  });
}

export async function waitForProcessStartup(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    }, STARTUP_GRACE_MS);

    const onError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const detail = stderr.trim() || `SSH tunnel exited early (code=${String(code)}, signal=${String(signal)})`;
      reject(new Error(detail));
    };

    const onStderr = (chunk: Buffer | string) => {
      stderr += chunk.toString();
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stderr?.off("data", onStderr);
    };

    child.on("error", onError);
    child.on("exit", onExit);
    child.stderr?.on("data", onStderr);
  });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    }, timeoutMs);

    child.once("exit", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}
