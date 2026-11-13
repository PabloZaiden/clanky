import type { Chat, ChatTranscript, ExecutionHostDescriptor, PersistedMessage, TerminalSession, VoiceSettings, Workspace } from "@/shared";
import type { FileDiffContent, ModelInfo } from "@/contracts";
import type { WebAppConfigResponse } from "@/platform/contracts";
import type { MeshControllerStatus } from "@/shared/mesh";
import { MESH_PROTOCOL_PREFERRED_VERSION, MESH_SUPPORTED_PROTOCOL_VERSIONS } from "@/shared/mesh-protocol";
import type { ControllerRelayPairingStatus } from "@/contracts/relay";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@/shared/agent-notifications";
import type { AgentNotificationSettings } from "@/contracts/schemas/agent-notifications";

export const DEMO_MODEL = { providerID: "copilot", modelID: "demo-simulated", variant: "" } as const;
export const DEMO_DIRECTORY = "/demo/observatory";
export const DEMO_MODELS: ModelInfo[] = [{
  ...DEMO_MODEL, providerName: "Demo simulation", modelName: "Demo simulated responses", connected: true,
}];
export const DEMO_HOST: ExecutionHostDescriptor = {
  ref: { kind: "local", nodeId: "demo-host" }, targetKey: "demo-host", name: "Demo imaginary server",
  endpoint: null, meshRouteKind: null, repositoriesBasePath: DEMO_DIRECTORY,
  preferredModel: DEMO_MODEL, configurationRevision: 1, accessRequirement: { kind: "none" },
  acceptRemoteExecution: true, platform: { os: "linux", architecture: "arm64" },
  capabilities: { fileOperations: 2, directoryTree: 1, git: 2, managedWorktrees: 3, acpRuntime: 2 },
  harnessAdapters: ["acp"], revision: 1,
};
export const DEMO_WORKER: ExecutionHostDescriptor = {
  ...DEMO_HOST, ref: { kind: "mesh", nodeId: "demo-worker" }, targetKey: "demo-worker",
  name: "Demo imaginary Mesh server", endpoint: "https://demo-worker.invalid", meshRouteKind: "direct",
};

export const DEMO_NOTIFICATIONS: AgentNotificationSettings = {
  ...DEFAULT_NOTIFICATION_PREFERENCES, configured: false, lastDeliveryError: null,
};
export const DEMO_RELAYS: ControllerRelayPairingStatus = {
  controllerFingerprint: "Demo fictional fingerprint", bootstrapEnvironment: "Demo simulation",
  primaryName: null, relays: [],
};

export function demoMeshStatus(now: string): MeshControllerStatus {
  return {
    node: {
      nodeId: "demo-host", instanceName: "Demo imaginary controller", meshEndpoint: null,
      publicKey: "Demo fictional public key", fingerprint: "Demo fictional fingerprint",
      encryptionPublicKey: "Demo fictional encryption key", createdAt: now, updatedAt: now,
      execution: {
        name: DEMO_HOST.name, endpoint: null, repositoriesBasePath: DEMO_DIRECTORY,
        preferredModel: DEMO_MODEL, acceptRemoteExecution: true, capabilities: DEMO_HOST.capabilities, revision: 1,
      },
    },
    workers: [{
      workerNodeId: "demo-worker", workerInstanceName: DEMO_WORKER.name,
      workerEndpoint: DEMO_WORKER.endpoint!, workerTransport: "https",
      workerPublicKey: "Demo fictional public key", workerFingerprint: "Demo fictional worker fingerprint",
      workerEncryptionPublicKey: "Demo fictional encryption key", workerTlsCertificate: null, workerTlsFingerprint: null,
      route: { kind: "direct", endpoint: DEMO_WORKER.endpoint!, transport: "https", tlsTrust: "system", tlsCertificate: null, tlsFingerprint: null },
      workerDirectory: DEMO_DIRECTORY, workerPlatform: DEMO_WORKER.platform, workerCapabilities: DEMO_WORKER.capabilities,
      workerAcceptRemoteExecution: true, workerConfigRevision: 1, grantStatus: "active", localUserId: "demo-user",
      lastSeenAt: now, createdAt: now, updatedAt: now,
      routeSecurity: { protocolVersion: null, payloadProtection: "unavailable", fallbackReason: "protocol-unavailable" },
    }],
    protocol: { binaryVersion: "Demo", supportedProtocolVersions: [...MESH_SUPPORTED_PROTOCOL_VERSIONS],
      preferredProtocolVersion: MESH_PROTOCOL_PREFERRED_VERSION, negotiatedProtocolVersion: null },
  };
}

export function demoConfig(): WebAppConfigResponse {
  return {
    appName: "Clanky Demo", version: "Demo", publicBasePath: "/", realtime: { path: "/api/realtime" },
    currentUser: { id: "demo-user", username: "Demo visitor", role: "user", isAdmin: false, isOwner: false },
    passkeyAuth: {
      enabled: false, passkeyConfigured: false, accountPasskeyConfigured: false, passkeyDisabled: true,
      passkeyRequired: false, authenticated: true, bootstrapRequired: false,
      ownerPasskeySetupRequired: false, passkeyAvailable: false, passwordEnabled: false,
    },
    userManagement: { enabled: false, canManageUsers: false }, logLevel: { level: "warn", fromEnv: false },
    inMemoryLogs: { enabled: false }, deviceAuth: { enabled: false }, apiKeys: { enabled: false },
  };
}

export function demoWorkspace(now: string): Workspace {
  return {
    id: "demo-workspace", name: "Demo Observatory", directory: DEMO_DIRECTORY,
    scratchpad: "# Demo Observatory\n\nA fictional project for exploring Clanky. Nothing runs on a real server.",
    workspaceType: "git", allowWorktrees: true, executionTargetRevision: 1,
    executionHostBinding: { host: DEMO_HOST.ref, targetKey: DEMO_HOST.targetKey, revision: 1 },
    serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
    createdAt: now, updatedAt: now, allowClankyContext: false,
  };
}

export function demoChat(id: string, name: string, now: string, host?: ExecutionHostDescriptor): Chat {
  return {
    config: {
      id, name, ...(host ? {
        source: { kind: "execution_host", executionHost: { host: host.ref, targetKey: host.targetKey, revision: 1 }, directory: DEMO_DIRECTORY },
      } : { workspaceId: "demo-workspace", source: { kind: "workspace", workspaceId: "demo-workspace" } }),
      executionHostBinding: { host: host?.ref ?? DEMO_HOST.ref, targetKey: host?.targetKey ?? DEMO_HOST.targetKey, revision: 1 },
      scope: "workspace", directory: DEMO_DIRECTORY, model: DEMO_MODEL, useWorktree: false,
      createdAt: now, updatedAt: now, mode: "chat",
    },
    state: {
      id, revision: 1, status: "idle", connectionStatus: "connected",
      messages: [{
        id: `${id}-welcome`, role: "assistant", timestamp: now,
        content: "Demo: this is an in-browser simulation, not an AI agent. Explore the fictional workspace, files and chat diff, or send a message for a simulated response. No commands run and no messages leave this demo.",
      }],
      logs: [], toolCalls: [], queuedMessages: [], pendingPermissionRequests: [], hasMessages: true, hasTranscript: true,
    },
  };
}


export function demoTerminal(now: string): TerminalSession {
  return {
    config: {
      id: "demo-terminal", name: "Demo: basic shell", workspaceId: "demo-workspace",
      directory: DEMO_DIRECTORY, connectionMode: "direct", useTmux: false,
      remoteSessionName: "demo-terminal", workspaceExecutionTargetRevision: 1,
      executionHostBinding: { host: DEMO_HOST.ref, targetKey: DEMO_HOST.targetKey, revision: 1 },
      createdAt: now, updatedAt: now,
    },
    state: { status: "ready" },
  };
}


export function demoTranscript(id: string, messages: PersistedMessage[], revision: number): ChatTranscript {
  const responses = messages.filter(message => message.role === "assistant").length;
  return {
    messages, logs: [], toolCalls: [], revision: `${id}:${revision}`,
    position: { epoch: `demo:${id}`, revision }, totalEntries: messages.length,
    isPartial: false, loadedResponses: responses, totalResponses: responses, hasOlder: false,
  };
}

export const DEMO_FILES: Readonly<Record<string, string>> = {
  "README.md": "# Demo Observatory\n\nThis fictional project exists only in your browser's memory.\n",
  "src/greeting.ts": 'export function greeting(): string {\n  return "Hello, stargazer!";\n}\n',
  "src/index.ts": 'import { greeting } from "./greeting";\n\nconsole.log(greeting());\n',
};

const unconfiguredVoice = {
  configured: false, validated: false, state: "unconfigured", checkedAt: null, error: null,
} as const;
export const DEMO_VOICE: VoiceSettings = {
  baseUrl: "", apiKeyConfigured: false, models: { transcription: "", text: "" }, languageHints: [],
  capabilities: { transcription: unconfiguredVoice, text: unconfiguredVoice, live: unconfiguredVoice },
  piper: { available: false },
  live: { useVoiceProvider: true, baseUrl: "", apiKeyConfigured: false, model: "", personalInstructions: "", configured: false },
};

export const DEMO_DIFF_BASE = "0123456789abcdef0123456789abcdef01234567";

export const DEMO_DIFF: FileDiffContent[] = [{
  path: "src/greeting.ts", status: "modified", additions: 1, deletions: 1,
  patch: 'diff --git a/src/greeting.ts b/src/greeting.ts\n--- a/src/greeting.ts\n+++ b/src/greeting.ts\n@@ -1,3 +1,3 @@\n export function greeting(): string {\n-  return "Hello";\n+  return "Hello, stargazer!";\n }\n',
}];
