import { fileURLToPath } from "node:url";

/**
 * Build the local command used to spawn the mock ACP runtime.
 * The runtime must use an absolute path because ACP stdio transports
 * spawn inside the selected workspace directory, not the Ralpher repo.
 */
export function getMockAcpCommand(): { command: string; args: string[] } {
  const serverPath = fileURLToPath(new URL("./mock-acp-server.ts", import.meta.url));
  return {
    command: process.execPath,
    args: [serverPath],
  };
}
