import { fileURLToPath } from "node:url";
import { isMockAcpEnabled } from "../../core/config";

export const INTERNAL_MOCK_ACP_ARGUMENT = "__clanky_internal_mock_acp";
const EMBEDDED_MOCK_ACP_ENV = "CLANKY_EMBEDDED_MOCK_ACP";

/**
 * Build the local command used to spawn the mock ACP runtime.
 * The runtime must use an absolute path because ACP stdio transports
 * spawn inside the selected workspace directory, not the Clanky repo.
 */
export function getMockAcpCommand(): { command: string; args: string[] } {
  if (process.env[EMBEDDED_MOCK_ACP_ENV] === "1") {
    return {
      command: process.execPath,
      args: [INTERNAL_MOCK_ACP_ARGUMENT],
    };
  }
  const serverPath = fileURLToPath(new URL("./mock-acp-server.ts", import.meta.url));
  const bunExecutable = Bun.which("bun") ?? process.execPath;
  return {
    command: bunExecutable,
    args: [serverPath],
  };
}

export function isEmbeddedMockAcpInvocation(
  args: string[] = process.argv.slice(2),
): boolean {
  return process.env[EMBEDDED_MOCK_ACP_ENV] === "1"
    && isMockAcpEnabled()
    && args.length === 1
    && args[0] === INTERNAL_MOCK_ACP_ARGUMENT;
}
