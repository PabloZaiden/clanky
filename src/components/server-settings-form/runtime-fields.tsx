/**
 * Workspace adapter and host settings rows.
 */

import type { ChangeEvent, ReactNode } from "react";
import { FormGroup, Select, SelectField, SettingsFieldRow } from "@pablozaiden/webapp/web";
import {
  executionHostRefsEqual, serializeExecutionHostRef,
  type HarnessAdapter, type ExecutionHostRef, type ExecutionHostDescriptor,
} from "@/shared";
import { HarnessRuntimeSelector } from "../harness-runtime-selector";

interface RuntimeFieldsProps {
  children?: ReactNode;
  layout: "fields" | "settings";
  adapter: HarnessAdapter;
  supportedAdapters: readonly HarnessAdapter[];
  adapterAvailabilityError?: ExecutionHostDescriptor["harnessAdapterError"];
  executionHost: ExecutionHostRef | null;
  loading: boolean;
  selectableTargets: ExecutionHostDescriptor[];
  unavailableInitialTarget?: ExecutionHostDescriptor;
  initialExecutionHost: ExecutionHostRef | null;
  initialDedicatedWorker: boolean;
  dedicatedWorkerSelected: boolean;
  dedicatedWorkerActive: boolean;
  updateAdapter: (adapter: HarnessAdapter) => void;
  updateExecutionHost: (host: string) => void;
}

export function RuntimeFields({
  children, layout, adapter, supportedAdapters, adapterAvailabilityError, executionHost,
  loading, selectableTargets, unavailableInitialTarget, initialExecutionHost,
  initialDedicatedWorker, dedicatedWorkerSelected, dedicatedWorkerActive,
  updateAdapter, updateExecutionHost,
}: RuntimeFieldsProps) {
  const unavailable = unavailableInitialTarget && executionHost
    && executionHostRefsEqual(unavailableInitialTarget.ref, executionHost);
  const adapterError = !loading && (adapterAvailabilityError
    ? "Harness availability could not be verified."
    : !supportedAdapters.includes(adapter)
      ? "This adapter is unavailable on the selected execution host." : null);
  const hostError = unavailable ? "Select a host that supports workspace operations." : undefined;
  const hostProps = {
    id: "execution-host",
    required: true,
    value: executionHost ? serializeExecutionHostRef(executionHost) : dedicatedWorkerActive ? "workspace-worker" : "",
    disabled: loading,
    onChange: (event: ChangeEvent<HTMLSelectElement>) => updateExecutionHost(event.currentTarget.value),
  };
  const hostOptions = (
    <>
      <option value="" disabled>{loading ? "Loading execution hosts..." : "Select an execution host"}</option>
      {dedicatedWorkerSelected && !initialDedicatedWorker ? <option value="workspace-worker">Dedicated worker</option> : null}
      {initialDedicatedWorker && initialExecutionHost ? <option value={serializeExecutionHostRef(initialExecutionHost)}>Dedicated worker</option> : null}
      {unavailableInitialTarget ? <option value={serializeExecutionHostRef(unavailableInitialTarget.ref)} disabled>{unavailableInitialTarget.name} - unavailable</option> : null}
      {selectableTargets.map((target) => <option key={serializeExecutionHostRef(target.ref)} value={serializeExecutionHostRef(target.ref)}>{target.name}</option>)}
    </>
  );
  return (
    <FormGroup>
      {layout === "fields" ? (
        <SelectField {...hostProps} label="Execution host" hint="Server for files and agents." error={hostError}>
          {hostOptions}
        </SelectField>
      ) : <SettingsFieldRow title="Execution host" labelFor={hostProps.id}
        description="Server for files and agents."
        feedback={hostError ? <span role="alert">{hostError}</span> : null}
        content={<Select {...hostProps} fieldWidth="normal">{hostOptions}</Select>} />}
      {children}
      <HarnessRuntimeSelector layout={layout} adapter={adapter} supportedAdapters={supportedAdapters}
        onAdapterChange={updateAdapter} />
      {adapterError ? <p className="text-sm text-amber-600 dark:text-amber-400" role="alert">{adapterError}</p> : null}
    </FormGroup>
  );
}
