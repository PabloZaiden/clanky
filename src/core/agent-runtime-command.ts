import type { AgentProvider } from "@/shared/settings";
import { mergeRuntimeEnvironment, withoutManagedContextEnvironment } from "./managed-context-environment";

export interface AgentRuntimeCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface AgentProviderRuntime {
  options: AcpResolverOptions;
  args: string[];
  env?: Record<string, string>;
}

const CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp";
const COPILOT_PACKAGE = "@github/copilot";
const OPENCODE_PACKAGE = "opencode-ai";
const CLAUDE_AGENT_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const PI_ACP_PACKAGE = "pi-acp";
const GROK_PACKAGE = "@xai-official/grok";
const CODEX_ACP_ENV = {
  INITIAL_AGENT_MODE: "agent-full-access",
  CODEX_CONFIG: JSON.stringify({
    approval_policy: "never",
    sandbox_mode: "danger-full-access",
  }),
};

interface AcpResolverOptions {
  executable?: string;
  packageName: string;
  errorLabel: string;
  requiredCli?: {
    command: string;
    errorMessage: string;
  };
}

function buildResolverErrorHint(options: AcpResolverOptions): string {
  if (options.executable) {
    return `Install ${options.executable} or ensure npx or bunx can run ${options.packageName}.`;
  }
  return `Ensure npx or bunx can run ${options.packageName}.`;
}

export class AgentRuntimeUnavailableError extends Error {
  readonly provider: AgentProvider;

  constructor(provider: AgentProvider, message: string) {
    super(message);
    this.name = "AgentRuntimeUnavailableError";
    this.provider = provider;
  }
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

const GROK_ACP_RESOLVER_OPTIONS: AcpResolverOptions = {
  executable: "grok",
  packageName: GROK_PACKAGE,
  errorLabel: "Grok Build CLI",
};

const AGENT_PROVIDER_RUNTIMES: Record<AgentProvider, AgentProviderRuntime> = {
  opencode: {
    options: OPENCODE_ACP_RESOLVER_OPTIONS,
    args: ["acp"],
  },
  copilot: {
    options: COPILOT_ACP_RESOLVER_OPTIONS,
    args: ["--yolo", "--acp"],
  },
  codex: {
    options: CODEX_ACP_RESOLVER_OPTIONS,
    args: [],
    env: CODEX_ACP_ENV,
  },
  claude: {
    options: CLAUDE_ACP_RESOLVER_OPTIONS,
    args: [],
  },
  pi: {
    options: PI_ACP_RESOLVER_OPTIONS,
    args: [],
  },
  grok: {
    options: GROK_ACP_RESOLVER_OPTIONS,
    args: ["agent", "--always-approve", "stdio"],
  },
};

/**
 * Build the default ACP CLI command for a provider.
 */
export function getProviderAcpCommand(
  provider: AgentProvider,
): AgentRuntimeCommand {
  return resolveProviderAcpCommand(provider);
}

export function resolveProviderAcpCommand(
  provider: AgentProvider,
  which: (command: string) => string | null = Bun.which,
): AgentRuntimeCommand {
  const runtime = AGENT_PROVIDER_RUNTIMES[provider];
  const requiredCli = runtime.options.requiredCli;
  if (requiredCli && !which(requiredCli.command)) {
    throw new AgentRuntimeUnavailableError(provider, requiredCli.errorMessage);
  }

  let command = runtime.options.executable
    ? which(runtime.options.executable)
    : null;
  let args = [...runtime.args];
  if (!command) {
    command = which("npx") ?? which("bunx");
    args = ["--yes", runtime.options.packageName, ...runtime.args];
  }
  if (!command) {
    throw new AgentRuntimeUnavailableError(
      provider,
      `clanky: ${runtime.options.errorLabel} not found. ${
        buildResolverErrorHint(runtime.options)
      }`,
    );
  }
  return {
    command,
    args,
    ...(runtime.env ? { env: runtime.env } : {}),
  };
}

export function isAgentProviderAvailable(
  provider: AgentProvider,
  which: (command: string) => string | null = Bun.which,
): boolean {
  try {
    resolveProviderAcpCommand(provider, which);
    return true;
  } catch (error) {
    if (error instanceof AgentRuntimeUnavailableError) {
      return false;
    }
    throw error;
  }
}

export function buildProviderSpawnEnvironment(
  providerCommand: AgentRuntimeCommand,
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const runtimeEnvironment = mergeRuntimeEnvironment(providerCommand.env, overrides);
  return withoutManagedContextEnvironment({
    ...baseEnv,
    ...runtimeEnvironment,
  }) ?? {};
}
