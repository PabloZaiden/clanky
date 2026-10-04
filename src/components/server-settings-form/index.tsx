/**
 * Shared workspace runtime form.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SERVER_AGENT_PROVIDER,
  createAgentSettings,
  executionHostRefsEqual,
  parseExecutionHostRef,
  supportsWorkspaceExecutionHost,
  type AgentProvider,
  type HarnessAdapter,
  type ExecutionHostRef,
  type ServerSettings,
} from "@/shared";
import {
  isEnrollmentMeshExecutionHostRef,
  isPrivateMeshExecutionHostRef,
  isWorkspaceMeshExecutionHostRef,
  isWorkspaceSshExecutionHostRef,
} from "@/shared/execution-host";
import type { WorkspaceSshTargetRequest } from "@/contracts/schemas";
import { RuntimeFields } from "./runtime-fields";
import { useWorkspaceExecutionTargets } from "../../hooks/workspace-server-settings";
import { TestConnection } from "./test-connection";

export interface ServerSettingsFormProps {
  initialSettings?: ServerSettings;
  initialExecutionHost?: ExecutionHostRef | null;
  initialSshTarget?: InitialSshTarget | null;
  onChange: (
    settings: ServerSettings,
    isValid: boolean,
    executionHost: ExecutionHostRef | null,
    sshTarget?: WorkspaceSshTargetRequest | null,
  ) => void;
  onTest?: (
    settings: ServerSettings,
    executionHost: ExecutionHostRef | null,
    sshTarget?: WorkspaceSshTargetRequest | null,
  ) => Promise<{ success: boolean; error?: string }>;
  testing?: boolean;
  remoteOnly?: boolean;
  allowWorkspaceSshTarget?: boolean;
  dedicatedWorkerSelected?: boolean;
  workspaceWorkerEnrollmentId?: string;
}

export function ServerSettingsForm({
  initialSettings,
  initialExecutionHost = null,
  initialSshTarget = null,
  onChange,
  onTest,
  testing = false,
  remoteOnly = false,
  allowWorkspaceSshTarget = false,
  dedicatedWorkerSelected = false,
  workspaceWorkerEnrollmentId,
}: ServerSettingsFormProps) {
  const enrollmentId = dedicatedWorkerSelected
    ? workspaceWorkerEnrollmentId
    : initialExecutionHost && isEnrollmentMeshExecutionHostRef(initialExecutionHost)
      ? initialExecutionHost.enrollmentId
      : undefined;
  const { targets, loading } = useWorkspaceExecutionTargets({
    workspaceId: initialExecutionHost && isWorkspaceMeshExecutionHostRef(initialExecutionHost)
      ? initialExecutionHost.workspaceId
      : undefined,
    workspaceWorkerEnrollmentId: enrollmentId,
  });
  const selectableTargets = useMemo(
    () => targets.filter((target) =>
      target.acceptRemoteExecution
      && (!remoteOnly || target.ref.kind !== "local")
      && supportsWorkspaceExecutionHost(target.capabilities)
      && !isPrivateMeshExecutionHostRef(target.ref)
    ),
    [remoteOnly, targets],
  );
  const unavailableInitialTarget = useMemo(
    () => initialExecutionHost
      ? targets.find((target) =>
          executionHostRefsEqual(target.ref, initialExecutionHost)
          && (!target.acceptRemoteExecution
            || (remoteOnly && target.ref.kind === "local")
            || !supportsWorkspaceExecutionHost(target.capabilities))
        )
      : undefined,
    [initialExecutionHost, remoteOnly, targets],
  );
  const [provider, setProvider] = useState<AgentProvider>(
    initialSettings?.agent.provider ?? DEFAULT_SERVER_AGENT_PROVIDER,
  );
  const [adapter, setAdapter] = useState<HarnessAdapter>(initialSettings?.agent.adapter ?? "acp");
  const [executionHost, setExecutionHost] = useState<ExecutionHostRef | null>(
    initialExecutionHost,
  );
  const [sshTarget, setSshTarget] = useState<WorkspaceSshTargetRequest | null>(
    initialSshTarget
      ? toSshTargetRequest(initialSshTarget)
      : null,
  );
  const [clearStoredPassword, setClearStoredPassword] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
  } | null>(null);
  const initialDedicatedWorker = Boolean(
    initialExecutionHost && isPrivateMeshExecutionHostRef(initialExecutionHost),
  );
  const dedicatedWorkerActive = dedicatedWorkerSelected || initialDedicatedWorker;
  const supportedAdapters = getSupportedAdapters(executionHost, sshTarget);
  const isValid = isSelectionValid(adapter, executionHost, sshTarget);

  function getTarget(host: ExecutionHostRef | null) {
    return targets.find((candidate) => host
      ? executionHostRefsEqual(candidate.ref, host)
      : isEnrollmentMeshExecutionHostRef(candidate.ref)
        && candidate.ref.enrollmentId === enrollmentId,
    );
  }

  function getSupportedAdapters(host: ExecutionHostRef | null, target: WorkspaceSshTargetRequest | null): readonly HarnessAdapter[] {
    if (target) return ["acp"];
    const descriptor = getTarget(host);
    if (descriptor) {
      return descriptor.acceptRemoteExecution
        && (!remoteOnly || descriptor.ref.kind !== "local")
        && supportsWorkspaceExecutionHost(descriptor.capabilities)
        ? descriptor.harnessAdapters
        : [];
    }
    return !host && dedicatedWorkerSelected ? ["acp"] : [];
  }

  function isSelectionValid(nextAdapter: HarnessAdapter, host: ExecutionHostRef | null, target: WorkspaceSshTargetRequest | null): boolean {
    return !loading
      && getSupportedAdapters(host, target).includes(nextAdapter)
      && (target ? isSshTargetValid(target) : host !== null || dedicatedWorkerSelected);
  }

  useEffect(() => {
    onChangeRef.current({ agent: createAgentSettings(adapter, provider) }, isValid, executionHost, sshTarget);
  }, [isValid]);

  useEffect(() => {
    const nextProvider =
      initialSettings?.agent.provider ?? DEFAULT_SERVER_AGENT_PROVIDER;
    const nextAdapter = initialSettings?.agent.adapter ?? "acp";
    const workspaceSshRef = initialExecutionHost
      && isWorkspaceSshExecutionHostRef(initialExecutionHost);
    const nextExecutionHost = dedicatedWorkerSelected || workspaceSshRef
      ? null
      : initialExecutionHost;
    const nextSshTarget = initialSshTarget
      ? toSshTargetRequest(initialSshTarget)
      : workspaceSshRef
        ? {
          host: "",
          port: 22,
          username: "",
        }
        : null;
    setProvider(nextProvider);
    setAdapter(nextAdapter);
    setExecutionHost(nextExecutionHost);
    setSshTarget(nextSshTarget);
    setClearStoredPassword(false);
    setTestResult(null);
    onChangeRef.current(
      { agent: createAgentSettings(nextAdapter, nextProvider) },
      isSelectionValid(nextAdapter, nextExecutionHost, nextSshTarget),
      nextExecutionHost,
      nextSshTarget,
    );
  }, [dedicatedWorkerSelected, initialExecutionHost, initialSshTarget, initialSettings]);

  useEffect(() => {
    if (
      loading
      || executionHost
      || sshTarget
      || dedicatedWorkerActive
      || selectableTargets.length === 0
    ) {
      return;
    }
    const nextHost = selectableTargets[0]!.ref;
    setExecutionHost(nextHost);
    onChangeRef.current({ agent: createAgentSettings(adapter, provider) }, isSelectionValid(adapter, nextHost, null), nextHost);
  }, [
    dedicatedWorkerActive,
    adapter,
    executionHost,
    loading,
    provider,
    selectableTargets,
    sshTarget,
  ]);

  function updateProvider(nextProvider: AgentProvider): void {
    setProvider(nextProvider);
    setTestResult(null);
    onChangeRef.current(
      { agent: createAgentSettings(adapter, nextProvider) },
      isSelectionValid(adapter, executionHost, sshTarget),
      executionHost,
      sshTarget,
    );
  }

  function updateAdapter(nextAdapter: HarnessAdapter): void {
    setAdapter(nextAdapter);
    setTestResult(null);
    onChangeRef.current(
      { agent: createAgentSettings(nextAdapter, provider) },
      isSelectionValid(nextAdapter, executionHost, sshTarget),
      executionHost,
      sshTarget,
    );
  }

  function updateExecutionHost(serialized: string): void {
    if (serialized === "workspace-worker") {
      setExecutionHost(null);
      setSshTarget(null);
      setClearStoredPassword(false);
      setTestResult(null);
      onChangeRef.current({ agent: createAgentSettings(adapter, provider) }, isSelectionValid(adapter, null, null), null, null);
      return;
    }
    if (serialized === "workspace-ssh-target") {
      const nextTarget = sshTarget ?? {
        host: "",
        port: 22,
        username: "",
      };
      setExecutionHost(null);
      setSshTarget(nextTarget);
      setClearStoredPassword(false);
      setTestResult(null);
      onChangeRef.current(
        { agent: createAgentSettings(adapter, provider) },
        isSelectionValid(adapter, null, nextTarget),
        null,
        nextTarget,
      );
      return;
    }
    const nextHost = serialized ? parseExecutionHostRef(serialized) : null;
    setExecutionHost(nextHost);
    setSshTarget(null);
    setClearStoredPassword(false);
    setTestResult(null);
    onChangeRef.current({ agent: createAgentSettings(adapter, provider) }, isSelectionValid(adapter, nextHost, null), nextHost);
  }

  function updateSshTarget(
    field: "host" | "port" | "username" | "password",
    value: string | number | null | undefined,
  ): void {
    const nextTarget: WorkspaceSshTargetRequest = {
      ...(sshTarget ?? { host: "", port: 22, username: "" }),
      [field]: value,
    };
    if (field === "password" && value !== null && value !== "") {
      setClearStoredPassword(false);
    }
    setSshTarget(nextTarget);
    setTestResult(null);
    onChangeRef.current(
      { agent: createAgentSettings(adapter, provider) },
      isSelectionValid(adapter, null, nextTarget),
      null,
      nextTarget,
    );
  }

  function updateClearStoredPassword(clear: boolean): void {
    setClearStoredPassword(clear);
    const nextTarget: WorkspaceSshTargetRequest = {
      ...(sshTarget ?? { host: "", port: 22, username: "" }),
      password: clear ? null : undefined,
    };
    setSshTarget(nextTarget);
    setTestResult(null);
    onChangeRef.current(
      { agent: createAgentSettings(adapter, provider) },
      isSelectionValid(adapter, null, nextTarget),
      null,
      nextTarget,
    );
  }

  async function handleTest(): Promise<void> {
    if (
      !onTest
      || !isValid
    ) {
      return;
    }
    setTestResult(null);
    setTestResult(await onTest({ agent: createAgentSettings(adapter, provider) }, executionHost, sshTarget));
  }

  return (
    <div className="space-y-6">
      <RuntimeFields
        adapter={adapter}
        supportedAdapters={supportedAdapters}
        adapterAvailabilityError={sshTarget ? undefined : getTarget(executionHost)?.harnessAdapterError}
        provider={provider}
        executionHost={executionHost}
        sshTarget={sshTarget}
        loading={loading}
        selectableTargets={selectableTargets}
        unavailableInitialTarget={unavailableInitialTarget}
        initialExecutionHost={initialExecutionHost}
        initialDedicatedWorker={initialDedicatedWorker}
        dedicatedWorkerSelected={dedicatedWorkerSelected}
        dedicatedWorkerActive={dedicatedWorkerActive}
        allowWorkspaceSshTarget={allowWorkspaceSshTarget}
        clearStoredPassword={clearStoredPassword}
        updateAdapter={updateAdapter}
        updateProvider={updateProvider}
        updateExecutionHost={updateExecutionHost}
        updateSshTarget={updateSshTarget}
        updateClearStoredPassword={updateClearStoredPassword}
        passwordConfigured={initialSshTarget?.credentialConfigured ?? false}
      />

      {onTest && (
        <TestConnection
          onTest={handleTest}
          testing={testing}
          disabled={!isValid}
          testResult={testResult}
        />
      )}
    </div>
  );
}

function isSshTargetValid(
  target: WorkspaceSshTargetRequest | null,
): boolean {
  return target !== null
    && target.host.trim().length > 0
    && target.username.trim().length > 0
    && Number.isInteger(target.port)
    && target.port >= 1
    && target.port <= 65535;
}

type InitialSshTarget = Pick<
  WorkspaceSshTargetRequest,
  "host" | "port" | "username" | "password"
> & {
  credentialConfigured?: boolean;
};

function toSshTargetRequest(target: InitialSshTarget): WorkspaceSshTargetRequest {
  return {
    host: target.host,
    port: target.port,
    username: target.username,
    ...(target.password !== undefined ? { password: target.password } : {}),
  };
}
