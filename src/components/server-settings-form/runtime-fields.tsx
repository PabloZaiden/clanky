/**
 * Workspace adapter, host and SSH settings rows.
 */

import { CheckboxField, FormGroup, Input, Select, SettingsFieldRow } from "@pablozaiden/webapp/web";
import {
  executionHostRefsEqual, serializeExecutionHostRef,
  type AgentProvider, type HarnessAdapter, type ExecutionHostRef, type ExecutionHostDescriptor,
} from "@/shared";
import type { WorkspaceSshTargetRequest } from "@/contracts/schemas";
import { HarnessRuntimeSelector } from "../harness-runtime-selector";

interface RuntimeFieldsProps {
  adapter: HarnessAdapter;
  supportedAdapters: readonly HarnessAdapter[];
  adapterAvailabilityError?: ExecutionHostDescriptor["harnessAdapterError"];
  provider: AgentProvider;
  executionHost: ExecutionHostRef | null;
  sshTarget: WorkspaceSshTargetRequest | null;
  loading: boolean;
  selectableTargets: ExecutionHostDescriptor[];
  unavailableInitialTarget?: ExecutionHostDescriptor;
  initialExecutionHost: ExecutionHostRef | null;
  initialDedicatedWorker: boolean;
  dedicatedWorkerSelected: boolean;
  dedicatedWorkerActive: boolean;
  allowWorkspaceSshTarget: boolean;
  passwordConfigured: boolean;
  clearStoredPassword: boolean;
  updateAdapter: (adapter: HarnessAdapter) => void;
  updateProvider: (provider: AgentProvider) => void;
  updateExecutionHost: (host: string) => void;
  updateSshTarget: (field: "host" | "port" | "username" | "password", value: string | number | null | undefined) => void;
  updateClearStoredPassword: (clear: boolean) => void;
}

export function RuntimeFields({
  adapter, supportedAdapters, adapterAvailabilityError, provider, executionHost, sshTarget,
  loading, selectableTargets, unavailableInitialTarget, initialExecutionHost,
  initialDedicatedWorker, dedicatedWorkerSelected, dedicatedWorkerActive,
  allowWorkspaceSshTarget, clearStoredPassword, updateAdapter, updateProvider,
  updateExecutionHost, updateSshTarget, updateClearStoredPassword, passwordConfigured,
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
          value={sshTarget ? "workspace-ssh-target" : executionHost ? serializeExecutionHostRef(executionHost) : dedicatedWorkerActive ? "workspace-worker" : ""}
          disabled={loading} onChange={(event) => updateExecutionHost(event.currentTarget.value)}>
          <option value="" disabled>{loading ? "Loading execution hosts..." : "Select an execution host"}</option>
          {allowWorkspaceSshTarget ? <option value="workspace-ssh-target">Direct SSH target</option> : null}
          {dedicatedWorkerSelected && !initialDedicatedWorker ? <option value="workspace-worker">Dedicated worker</option> : null}
          {initialDedicatedWorker && initialExecutionHost ? <option value={serializeExecutionHostRef(initialExecutionHost)}>Dedicated worker</option> : null}
          {unavailableInitialTarget ? <option value={serializeExecutionHostRef(unavailableInitialTarget.ref)} disabled>{unavailableInitialTarget.name} - unavailable</option> : null}
          {selectableTargets.map((target) => <option key={serializeExecutionHostRef(target.ref)} value={serializeExecutionHostRef(target.ref)}>{target.name}</option>)}
        </Select>} />
      {allowWorkspaceSshTarget && sshTarget ? <>
        <SettingsFieldRow title="SSH host" labelFor="workspace-ssh-target-host" content={
          <Input id="workspace-ssh-target-host" fieldWidth="normal" required value={sshTarget.host}
            onChange={(event) => updateSshTarget("host", event.currentTarget.value)} placeholder="devcontainer.example.com" />
        } />
        <SettingsFieldRow title="SSH port" labelFor="workspace-ssh-target-port" content={
          <Input id="workspace-ssh-target-port" fieldWidth="short" type="number" required min={1} max={65535} value={sshTarget.port}
            onChange={(event) => updateSshTarget("port", Number(event.currentTarget.value))} />
        } />
        <SettingsFieldRow title="SSH username" labelFor="workspace-ssh-target-username" content={
          <Input id="workspace-ssh-target-username" fieldWidth="short" required value={sshTarget.username}
            onChange={(event) => updateSshTarget("username", event.currentTarget.value)} placeholder="devbox" />
        } />
        <SettingsFieldRow title="SSH password" labelFor="workspace-ssh-target-password"
          description={passwordConfigured ? "Leave blank to keep the saved password." : "Leave blank for key-based authentication."}
          content={<Input id="workspace-ssh-target-password" fieldWidth="normal" type="password" autoComplete="new-password"
            value={typeof sshTarget.password === "string" ? sshTarget.password : ""} disabled={clearStoredPassword}
            onChange={(event) => updateSshTarget("password", event.currentTarget.value || undefined)} />} />
        {passwordConfigured ? <SettingsFieldRow title="Remove saved password" danger labelFor="workspace-ssh-clear-password"
          content={<CheckboxField label="" aria-label="Remove the stored SSH password" id="workspace-ssh-clear-password"
            checked={clearStoredPassword} onChange={(event) => updateClearStoredPassword(event.currentTarget.checked)} />} /> : null}
      </> : null}
    </FormGroup>
  );
}
