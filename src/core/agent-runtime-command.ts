import type { AgentProvider, AgentTransport } from "../types/settings";
import { getMockAcpCommand } from "../backends/acp/mock-acp-command";
import { isMockAcpEnabled } from "./config";
import { quoteShell } from "./remote-executor/utils";

export interface AgentRuntimeCommand {
  command: string;
  args: string[];
}

interface AgentProviderRuntime {
  getAcpCommand(): AgentRuntimeCommand;
}

const CODEX_ACP_PACKAGE = "@zed-industries/codex-acp";
const CODEX_ACP_CONFIG_ARGS = [
  "-c",
  "approval_policy=\"never\"",
  "-c",
  "sandbox_mode=\"danger-full-access\"",
];

const CODEX_ACP_RESOLVER_SCRIPT = [
  "if ! command -v codex >/dev/null 2>&1; then",
  "echo \"clanky: Codex CLI not found. Install and authenticate codex before using the Codex provider.\" >&2;",
  "exit 127;",
  "elif command -v codex-acp >/dev/null 2>&1; then",
  "exec codex-acp \"$@\";",
  "elif command -v npx >/dev/null 2>&1; then",
  `exec npx --yes ${CODEX_ACP_PACKAGE} "$@";`,
  "elif command -v bunx >/dev/null 2>&1; then",
  `exec bunx --yes ${CODEX_ACP_PACKAGE} "$@";`,
  "else",
  `echo "clanky: Codex ACP adapter not found. Install codex-acp or ensure npx or bunx can run ${CODEX_ACP_PACKAGE}." >&2;`,
  "exit 127;",
  "fi",
].join(" ");

const AGENT_PROVIDER_RUNTIMES: Record<AgentProvider, AgentProviderRuntime> = {
  opencode: {
    getAcpCommand: () => ({ command: "opencode", args: ["acp"] }),
  },
  copilot: {
    getAcpCommand: () => ({ command: "copilot", args: ["--yolo", "--acp"] }),
  },
  codex: {
    getAcpCommand: () => ({
      command: "sh",
      args: ["-c", CODEX_ACP_RESOLVER_SCRIPT, "codex-acp", ...CODEX_ACP_CONFIG_ARGS],
    }),
  },
};

/**
 * Build the default ACP CLI command for a provider.
 */
export function getProviderAcpCommand(
  provider: AgentProvider,
  transport: AgentTransport = "stdio",
): AgentRuntimeCommand {
  if (transport === "stdio" && isMockAcpEnabled()) {
    return getMockAcpCommand();
  }
  return AGENT_PROVIDER_RUNTIMES[provider].getAcpCommand();
}

export function buildProviderShellInvocation(providerCommand: AgentRuntimeCommand): string {
  return [providerCommand.command, ...providerCommand.args]
    .map((value) => quoteShell(value))
    .join(" ");
}
