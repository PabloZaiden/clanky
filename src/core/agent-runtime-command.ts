import type { AgentProvider } from "../types/settings";
import { getMockAcpCommand } from "../backends/acp/mock-acp-command";
import { isMockAcpEnabled } from "./config";

/**
 * Build the default ACP CLI command for a provider.
 */
export function getProviderAcpCommand(provider: AgentProvider): { command: string; args: string[] } {
  if (isMockAcpEnabled()) {
    return getMockAcpCommand();
  }
  if (provider === "copilot") {
    return { command: "copilot", args: ["--yolo", "--acp"] };
  }
  return { command: "opencode", args: ["acp"] };
}
