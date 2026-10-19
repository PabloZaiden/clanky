/**
 * Local CLI control for the Devbox-owned worker loop.
 */

import type { WorkerServiceCommand } from "./worker-service";

export async function runWorkspaceWorkerService(
  script: string,
  command: WorkerServiceCommand,
): Promise<Record<string, unknown>> {
  if (command.operation === "install" || command.operation === "uninstall") {
    throw new Error("The workspace worker loop is installed and removed by the workspace lifecycle.");
  }
  const child = Bun.spawn(["sh", script, command.operation], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Workspace worker ${command.operation} failed: ${stderr.trim() || `exit code ${String(exitCode)}`}`);
  }
  if (command.operation === "start") {
    return { supervisor: "workspace-loop", operation: "start" };
  }
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch (error) {
    throw new Error("The workspace worker loop returned invalid JSON.", { cause: error });
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("The workspace worker loop returned an invalid status.");
  }
  return Object.fromEntries(Object.entries(result));
}
