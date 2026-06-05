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
const COPILOT_PACKAGE = "@github/copilot";
const OPENCODE_PACKAGE = "opencode-ai";
const CLAUDE_AGENT_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const PI_ACP_PACKAGE = "pi-acp";
const CODEX_ACP_CONFIG_ARGS = [
  "-c",
  "approval_policy=\"never\"",
  "-c",
  "sandbox_mode=\"danger-full-access\"",
];

interface AcpResolverOptions {
  executable?: string;
  packageName: string;
  errorLabel: string;
  requiredCli?: {
    command: string;
    errorMessage: string;
  };
}

function buildAcpResolverScript(options: AcpResolverOptions): string {
  const lines: string[] = [];
  if (options.requiredCli) {
    lines.push(
      `if ! command -v ${options.requiredCli.command} >/dev/null 2>&1; then`,
      `echo "${options.requiredCli.errorMessage}" >&2;`,
      "exit 127;",
      "fi",
    );
  }

  if (options.executable) {
    lines.push(
      `if command -v ${options.executable} >/dev/null 2>&1; then`,
      `exec ${options.executable} "$@";`,
      "elif command -v npx >/dev/null 2>&1; then",
    );
  } else {
    lines.push("if command -v npx >/dev/null 2>&1; then");
  }

  return [
    ...lines,
    `exec npx --yes ${options.packageName} "$@";`,
    "elif command -v bunx >/dev/null 2>&1; then",
    `exec bunx --yes ${options.packageName} "$@";`,
    "else",
    `echo "clanky: ${options.errorLabel} not found. ${buildResolverErrorHint(options)}" >&2;`,
    "exit 127;",
    "fi",
  ].join("\n");
}

function buildResolverErrorHint(options: AcpResolverOptions): string {
  if (options.executable) {
    return `Install ${options.executable} or ensure npx or bunx can run ${options.packageName}.`;
  }
  return `Ensure npx or bunx can run ${options.packageName}.`;
}

function buildAcpResolverCommand(
  options: AcpResolverOptions,
  args: string[],
): AgentRuntimeCommand {
  return {
    command: "sh",
    args: ["-c", buildAcpResolverScript(options), options.executable ?? options.packageName, ...args],
  };
}

const CODEX_ACP_RESOLVER_OPTIONS: AcpResolverOptions = {
  executable: "codex-acp",
  packageName: CODEX_ACP_PACKAGE,
  errorLabel: "Codex ACP adapter",
  requiredCli: {
    command: "codex",
    errorMessage: "clanky: Codex CLI not found. Install and authenticate codex before using the Codex provider.",
  },
};

const COPILOT_ACP_RESOLVER_OPTIONS: AcpResolverOptions = {
  executable: "copilot",
  packageName: COPILOT_PACKAGE,
  errorLabel: "Copilot CLI",
};

const OPENCODE_ACP_RESOLVER_OPTIONS: AcpResolverOptions = {
  executable: "opencode",
  packageName: OPENCODE_PACKAGE,
  errorLabel: "OpenCode CLI",
};

const CLAUDE_ACP_RESOLVER_OPTIONS: AcpResolverOptions = {
  executable: "claude-agent-acp",
  packageName: CLAUDE_AGENT_ACP_PACKAGE,
  errorLabel: "Claude Code ACP adapter",
};

const PI_ACP_RESOLVER_OPTIONS: AcpResolverOptions = {
  executable: "pi-acp",
  packageName: PI_ACP_PACKAGE,
  errorLabel: "Pi ACP adapter",
};

const AGENT_PROVIDER_RUNTIMES: Record<AgentProvider, AgentProviderRuntime> = {
  opencode: {
    getAcpCommand: () => buildAcpResolverCommand(
      OPENCODE_ACP_RESOLVER_OPTIONS,
      ["acp"],
    ),
  },
  copilot: {
    getAcpCommand: () => buildAcpResolverCommand(
      COPILOT_ACP_RESOLVER_OPTIONS,
      ["--yolo", "--acp"],
    ),
  },
  codex: {
    getAcpCommand: () => buildAcpResolverCommand(
      CODEX_ACP_RESOLVER_OPTIONS,
      CODEX_ACP_CONFIG_ARGS,
    ),
  },
  claude: {
    getAcpCommand: () => buildAcpResolverCommand(
      CLAUDE_ACP_RESOLVER_OPTIONS,
      [],
    ),
  },
  pi: {
    getAcpCommand: () => buildAcpResolverCommand(
      PI_ACP_RESOLVER_OPTIONS,
      [],
    ),
  },
};

const PROVIDER_ACP_RESOLVER_OPTIONS: Record<AgentProvider, AcpResolverOptions> = {
  opencode: OPENCODE_ACP_RESOLVER_OPTIONS,
  copilot: COPILOT_ACP_RESOLVER_OPTIONS,
  codex: CODEX_ACP_RESOLVER_OPTIONS,
  claude: CLAUDE_ACP_RESOLVER_OPTIONS,
  pi: PI_ACP_RESOLVER_OPTIONS,
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

export function buildProviderAvailabilityShellCheck(provider: AgentProvider): string {
  const options = PROVIDER_ACP_RESOLVER_OPTIONS[provider];
  const runtimeChecks = [
    ...(options.executable ? [`command -v ${options.executable} >/dev/null 2>&1`] : []),
    "command -v npx >/dev/null 2>&1",
    "command -v bunx >/dev/null 2>&1",
  ];
  const runtimeCheck = `{ ${runtimeChecks.join(" || ")}; }`;

  if (!options.requiredCli) {
    return runtimeCheck;
  }

  return `command -v ${options.requiredCli.command} >/dev/null 2>&1 && ${runtimeCheck}`;
}
