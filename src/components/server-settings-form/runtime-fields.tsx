/**
 * Workspace adapter and host settings rows.
 */

import { FormGroup, Select, SettingsFieldRow } from "@pablozaiden/webapp/web";
import {
  executionHostRefsEqual, serializeExecutionHostRef,
  type AgentProvider, type HarnessAdapter, type ExecutionHostRef, type ExecutionHostDescriptor,
} from "@/shared";
import { HarnessRuntimeSelector } from "../harness-runtime-selector";

interface RuntimeFieldsProps {
  adapter: HarnessAdapter;
  supportedAdapters: readonly HarnessAdapter[];
  adapterAvailabilityError?: ExecutionHostDescriptor["harnessAdapterError"];
  provider: AgentProvider;
  executionHost: ExecutionHostRef | null;
  loading: boolean;
  selectableTargets: ExecutionHostDescriptor[];
  unavailableInitialTarget?: ExecutionHostDescriptor;
  initialExecutionHost: ExecutionHostRef | null;
  initialDedicatedWorker: boolean;
  dedicatedWorkerSelected: boolean;
  dedicatedWorkerActive: boolean;
  updateAdapter: (adapter: HarnessAdapter) => void;
  updateProvider: (provider: AgentProvider) => void;
  updateExecutionHost: (host: string) => void;
}

export function RuntimeFields({
  adapter, supportedAdapters, adapterAvailabilityError, provider, executionHost,
  loading, selectableTargets, unavailableInitialTarget, initialExecutionHost,
  initialDedicatedWorker, dedicatedWorkerSelected, dedicatedWorkerActive,
  updateAdapter, updateProvider, updateExecutionHost,
}: RuntimeFieldsProps) {
  const unavailable = unavailableInitialTarget && executionHost
    && executionHostRefsEqual(unavailableInitialTarget.ref, executionHost);
  const adapterError = !loading && (adapterAvailabilityError
    ? "Harness availability could not be verified."
    : adapter !== "acp" && !supportedAdapters.includes(adapter)
      ? "This adapter is unavailable on the selected execution host." : null);
  return (
    <FormGroup>
      <HarnessRuntimeSelector layout="settings" adapter={adapter} provider={provider} supportedAdapters={supportedAdapters}
        onAdapterChange={updateAdapter} onProviderChange={updateProvider} />
      {adapterError ? <p className="text-sm text-amber-600 dark:text-amber-400" role="alert">{adapterError}</p> : null}
      <SettingsFieldRow title="Execution host" labelFor="execution-host"
        feedback={unavailable ? <span role="alert">Select a host that supports workspace operations.</span> : null}
        content={<Select id="execution-host" fieldWidth="normal" required
          value={executionHost ? serializeExecutionHostRef(executionHost) : dedicatedWorkerActive ? "workspace-worker" : ""}
          disabled={loading} onChange={(event) => updateExecutionHost(event.currentTarget.value)}>
          <option value="" disabled>{loading ? "Loading execution hosts..." : "Select an execution host"}</option>
          {dedicatedWorkerSelected && !initialDedicatedWorker ? <option value="workspace-worker">Dedicated worker</option> : null}
          {initialDedicatedWorker && initialExecutionHost ? <option value={serializeExecutionHostRef(initialExecutionHost)}>Dedicated worker</option> : null}
          {unavailableInitialTarget ? <option value={serializeExecutionHostRef(unavailableInitialTarget.ref)} disabled>{unavailableInitialTarget.name} - unavailable</option> : null}
          {selectableTargets.map((target) => <option key={serializeExecutionHostRef(target.ref)} value={serializeExecutionHostRef(target.ref)}>{target.name}</option>)}
        </Select>} />
    </FormGroup>
  );
}
