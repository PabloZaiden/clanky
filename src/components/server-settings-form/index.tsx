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
} from "@/shared/execution-host";
import { RuntimeFields } from "./runtime-fields";
import { useWorkspaceExecutionTargets } from "../../hooks/workspace-server-settings";
import { TestConnection } from "./test-connection";

export interface ServerSettingsFormProps {
  controllerId?: string;
  workspaceId?: string;
  initialSettings?: ServerSettings;
  initialExecutionHost?: ExecutionHostRef | null;
  onChange: (
    settings: ServerSettings,
    isValid: boolean,
    executionHost: ExecutionHostRef | null,
  ) => void;
  onTest?: (
    settings: ServerSettings,
    executionHost: ExecutionHostRef | null,
  ) => Promise<{ success: boolean; error?: string }>;
  testing?: boolean;
  remoteOnly?: boolean;
  dedicatedWorkerSelected?: boolean;
  workspaceWorkerEnrollmentId?: string;
}

export function ServerSettingsForm({
  controllerId,
  workspaceId,
  initialSettings,
  initialExecutionHost = null,
  onChange,
  onTest,
  testing = false,
  remoteOnly = false,
  dedicatedWorkerSelected = false,
  workspaceWorkerEnrollmentId,
}: ServerSettingsFormProps) {
  const enrollmentId = dedicatedWorkerSelected
    ? workspaceWorkerEnrollmentId
    : initialExecutionHost && isEnrollmentMeshExecutionHostRef(initialExecutionHost)
      ? initialExecutionHost.enrollmentId
      : undefined;
  const { targets, loading } = useWorkspaceExecutionTargets({
    controllerId,
    workspaceId: workspaceId ?? (initialExecutionHost && isWorkspaceMeshExecutionHostRef(initialExecutionHost)
      ? initialExecutionHost.workspaceId
      : undefined),
    workspaceWorkerEnrollmentId: enrollmentId,
  });
  const selectableTargets = useMemo(
    () => targets.filter((target) =>
      target.acceptRemoteExecution
      && (!remoteOnly || target.ref.kind !== "local")
      && target.harnessAdapters.some((candidate) =>
        supportsWorkspaceExecutionHost(target.capabilities, candidate))
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
            || !target.harnessAdapters.some((candidate) =>
              supportsWorkspaceExecutionHost(target.capabilities, candidate)))
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
  const supportedAdapters = getSupportedAdapters(executionHost);
  const isValid = isSelectionValid(adapter, executionHost);

  function getTarget(host: ExecutionHostRef | null) {
    return targets.find((candidate) => host
      ? executionHostRefsEqual(candidate.ref, host)
      : isEnrollmentMeshExecutionHostRef(candidate.ref)
        && candidate.ref.enrollmentId === enrollmentId,
    );
  }

  function getSupportedAdapters(host: ExecutionHostRef | null): readonly HarnessAdapter[] {
    const descriptor = getTarget(host);
    if (descriptor) {
      return descriptor.acceptRemoteExecution
        && (!remoteOnly || descriptor.ref.kind !== "local")
        ? descriptor.harnessAdapters.filter((candidate) =>
          supportsWorkspaceExecutionHost(descriptor.capabilities, candidate))
        : [];
    }
    return !host && dedicatedWorkerSelected ? ["acp"] : [];
  }

  function isSelectionValid(nextAdapter: HarnessAdapter, host: ExecutionHostRef | null): boolean {
    return !loading
      && getSupportedAdapters(host).includes(nextAdapter)
      && (host !== null || dedicatedWorkerSelected);
  }

  function updateSelection(change: {
    adapter?: HarnessAdapter;
    provider?: AgentProvider;
    executionHost?: ExecutionHostRef | null;
  }): void {
    const nextAdapter = change.adapter ?? adapter;
    const nextProvider = change.provider ?? provider;
    const nextHost = change.executionHost === undefined ? executionHost : change.executionHost;
    setAdapter(nextAdapter);
    setProvider(nextProvider);
    setExecutionHost(nextHost);
    setTestResult(null);
    onChangeRef.current(
      { agent: createAgentSettings(nextAdapter, nextProvider) },
      isSelectionValid(nextAdapter, nextHost),
      nextHost,
    );
  }

  useEffect(() => {
    onChangeRef.current({ agent: createAgentSettings(adapter, provider) }, isValid, executionHost);
  }, [isValid]);

  useEffect(() => {
    const nextProvider =
      initialSettings?.agent.provider ?? DEFAULT_SERVER_AGENT_PROVIDER;
    const nextAdapter = initialSettings?.agent.adapter ?? "acp";
    const nextExecutionHost = dedicatedWorkerSelected
      ? null
      : initialExecutionHost;
    updateSelection({ adapter: nextAdapter, provider: nextProvider, executionHost: nextExecutionHost });
  }, [dedicatedWorkerSelected, initialExecutionHost, initialSettings]);

  useEffect(() => {
    if (
      loading
      || executionHost
      || dedicatedWorkerActive
      || selectableTargets.length === 0
    ) {
      return;
    }
    const nextHost = selectableTargets[0]!.ref;
    updateSelection({ executionHost: nextHost });
  }, [
    dedicatedWorkerActive,
    adapter,
    executionHost,
    loading,
    provider,
    selectableTargets,
  ]);

  function updateProvider(nextProvider: AgentProvider): void {
    updateSelection({ provider: nextProvider });
  }

  function updateAdapter(nextAdapter: HarnessAdapter): void {
    updateSelection({ adapter: nextAdapter });
  }

  function updateExecutionHost(serialized: string): void {
    if (serialized === "workspace-worker") {
      updateSelection({ executionHost: null });
      return;
    }
    const nextHost = serialized ? parseExecutionHostRef(serialized) : null;
    updateSelection({ executionHost: nextHost });
  }

  async function handleTest(): Promise<void> {
    if (
      !onTest
      || !isValid
    ) {
      return;
    }
    setTestResult(null);
    setTestResult(await onTest({ agent: createAgentSettings(adapter, provider) }, executionHost));
  }

  return (
    <div className="space-y-6">
      <RuntimeFields
        adapter={adapter}
        supportedAdapters={supportedAdapters}
        adapterAvailabilityError={getTarget(executionHost)?.harnessAdapterError}
        provider={provider}
        executionHost={executionHost}
        loading={loading}
        selectableTargets={selectableTargets}
        unavailableInitialTarget={unavailableInitialTarget}
        initialExecutionHost={initialExecutionHost}
        initialDedicatedWorker={initialDedicatedWorker}
        dedicatedWorkerSelected={dedicatedWorkerSelected}
        dedicatedWorkerActive={dedicatedWorkerActive}
        updateAdapter={updateAdapter}
        updateProvider={updateProvider}
        updateExecutionHost={updateExecutionHost}
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
