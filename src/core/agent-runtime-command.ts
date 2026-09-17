import type { AgentProvider, AgentTransport } from "@/shared/settings";
import { getMockAcpCommand } from "../backends/acp/mock-acp-command";
import { isMockAcpEnabled } from "./config";
import { mergeRuntimeEnvironment } from "./managed-context-environment";
import { buildEnvAssignments, quoteShell } from "./remote-executor/utils";

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
const WINDOWS_COMMAND_SHIM_PATTERN = /\.(?:cmd|bat)$/i;
const WINDOWS_COMMAND_SHIM_SCRIPT = [
  "$commandPath = $args[0]",
  "$commandArgs = @($args | Select-Object -Skip 1)",
  "& $commandPath @commandArgs",
  "exit $LASTEXITCODE",
].join("; ");
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
  env?: Record<string, string>,
): AgentRuntimeCommand {
  return {
    command: "sh",
    args: ["-c", buildAcpResolverScript(options), options.executable ?? options.packageName, ...args],
    ...(env ? { env } : {}),
  };
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

const PROVIDER_ACP_RESOLVER_OPTIONS: Record<AgentProvider, AcpResolverOptions> = {
  opencode: OPENCODE_ACP_RESOLVER_OPTIONS,
  copilot: COPILOT_ACP_RESOLVER_OPTIONS,
  codex: CODEX_ACP_RESOLVER_OPTIONS,
  claude: CLAUDE_ACP_RESOLVER_OPTIONS,
  pi: PI_ACP_RESOLVER_OPTIONS,
  grok: GROK_ACP_RESOLVER_OPTIONS,
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
  const runtime = AGENT_PROVIDER_RUNTIMES[provider];
  if (transport === "ssh") {
    return buildAcpResolverCommand(
      runtime.options,
      runtime.args,
      runtime.env,
    );
  }
  return resolveProviderAcpCommand(provider);
}

export function resolveProviderAcpCommand(
  provider: AgentProvider,
  which: (command: string) => string | null = Bun.which,
  platform: NodeJS.Platform = process.platform,
): AgentRuntimeCommand {
  if (isMockAcpEnabled()) {
    return getMockAcpCommand();
  }
  const runtime = AGENT_PROVIDER_RUNTIMES[provider];
  const requiredCli = runtime.options.requiredCli;
  if (requiredCli && !which(requiredCli.command)) {
    throw new AgentRuntimeUnavailableError(provider, requiredCli.errorMessage);
  }

  const executable = runtime.options.executable
    ? which(runtime.options.executable)
    : null;
  if (executable) {
    return adaptProviderCommandForPlatform(
      provider,
      executable,
      runtime.args,
      runtime.env,
      which,
      platform,
    );
  }

  const npx = which("npx");
  if (npx) {
    return adaptProviderCommandForPlatform(
      provider,
      npx,
      ["--yes", runtime.options.packageName, ...runtime.args],
      runtime.env,
      which,
      platform,
    );
  }

  const bunx = which("bunx");
  if (bunx) {
    return adaptProviderCommandForPlatform(
      provider,
      bunx,
      ["--yes", runtime.options.packageName, ...runtime.args],
      runtime.env,
      which,
      platform,
    );
  }

  throw new AgentRuntimeUnavailableError(
    provider,
    `clanky: ${runtime.options.errorLabel} not found. ${
      buildResolverErrorHint(runtime.options)
    }`,
  );
}

function adaptProviderCommandForPlatform(
  provider: AgentProvider,
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  which: (command: string) => string | null,
  platform: NodeJS.Platform,
): AgentRuntimeCommand {
  if (platform !== "win32" || !WINDOWS_COMMAND_SHIM_PATTERN.test(command)) {
    return {
      command,
      args: [...args],
      ...(env ? { env } : {}),
    };
  }

  const powershell = which("powershell.exe") ?? which("powershell");
  if (!powershell) {
    throw new AgentRuntimeUnavailableError(
      provider,
      "clanky: Windows PowerShell is required to run the resolved ACP command shim.",
    );
  }
  return {
    command: powershell,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_COMMAND_SHIM_SCRIPT,
      command,
      ...args,
    ],
    ...(env ? { env } : {}),
  };
}

export function isAgentProviderAvailable(
  provider: AgentProvider,
  which: (command: string) => string | null = Bun.which,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    resolveProviderAcpCommand(provider, which, platform);
    return true;
  } catch (error) {
    if (error instanceof AgentRuntimeUnavailableError) {
      return false;
    }
    throw error;
  }
}

export function buildProviderShellInvocation(
  providerCommand: AgentRuntimeCommand,
  runtimeEnvironment?: Record<string, string>,
): string {
  const environment = mergeRuntimeEnvironment(providerCommand.env, runtimeEnvironment);
  return [
    ...buildEnvAssignments(environment),
    quoteShell(providerCommand.command),
    ...providerCommand.args.map((value) => quoteShell(value)),
  ].join(" ");
}

export function buildProviderSpawnEnvironment(
  providerCommand: AgentRuntimeCommand,
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  const runtimeEnvironment = mergeRuntimeEnvironment(providerCommand.env, overrides);
  if (!runtimeEnvironment) {
    return undefined;
  }

  return {
    ...baseEnv,
    ...runtimeEnvironment,
  };
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
