import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, FormActions, FormGroup, SettingsFieldRow, TextField, useToast, useUnsavedChanges } from "@pablozaiden/webapp/web";
import type { UseMeshResult } from "../../hooks";
import { SettingsError } from "./settings-row-controls";

export function ControllerSettingsContent({ mesh }: { mesh: UseMeshResult }) {
  const toast = useToast();
  const [instanceName, setInstanceName] = useState("");
  const [meshEndpoint, setMeshEndpoint] = useState("");
  const identity = useRef({ instanceName, meshEndpoint });
  identity.current = { instanceName, meshEndpoint };
  const [synced, setSynced] = useState<string | undefined>(undefined);
  const dirty = synced !== undefined && JSON.stringify(identity.current) !== synced;
  function reset(): void {
    setInstanceName(mesh.status?.node.instanceName ?? "");
    setMeshEndpoint(mesh.status?.node.meshEndpoint ?? "");
  }
  useUnsavedChanges(dirty, reset);
  useEffect(() => {
    if (!mesh.status) return;
    if (synced === undefined || JSON.stringify(identity.current) === synced) {
      setInstanceName(mesh.status.node.instanceName ?? "");
      setMeshEndpoint(mesh.status.node.meshEndpoint ?? "");
    }
    setSynced(JSON.stringify({
      instanceName: mesh.status.node.instanceName ?? "",
      meshEndpoint: mesh.status.node.meshEndpoint ?? "",
    }));
  }, [mesh.status?.node.instanceName, mesh.status?.node.meshEndpoint]);
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    let next = mesh.status;
    if (instanceName !== (mesh.status?.node.instanceName ?? "")) {
      next = await mesh.updateInstanceName(instanceName);
      if (!next) return;
    }
    if (meshEndpoint !== (mesh.status?.node.meshEndpoint ?? "")) {
      next = await mesh.updateMeshEndpoint(meshEndpoint);
      if (!next) return;
    }
    if (next) {
      setInstanceName(next.node.instanceName ?? "");
      setMeshEndpoint(next.node.meshEndpoint ?? "");
      setSynced(JSON.stringify({
        instanceName: next.node.instanceName ?? "",
        meshEndpoint: next.node.meshEndpoint ?? "",
      }));
      toast.success("Controller saved.");
    }
  }
  return <div className="space-y-5">
    {mesh.mutationError || mesh.error ? <SettingsError>{mesh.mutationError ?? mesh.error}</SettingsError> : null}
    <form onSubmit={(event) => void save(event)}>
      <FormGroup>
        <TextField label="Name" required maxLength={64} value={instanceName}
          onChange={(event) => setInstanceName(event.currentTarget.value)} disabled={mesh.saving} />
        <TextField label="Endpoint" type="url" fieldWidth="full" required={Boolean(mesh.status?.node.meshEndpoint)} value={meshEndpoint}
          onChange={(event) => setMeshEndpoint(event.currentTarget.value)} disabled={mesh.saving} />
        <FormActions>
          <Button disabled={mesh.saving || !dirty} onClick={reset}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!dirty} loading={mesh.saving}>Save</Button>
        </FormActions>
      </FormGroup>
    </form>
    {mesh.status ? <FormGroup title="Runtime">
      <SettingsFieldRow title="Version" content={mesh.status.protocol.binaryVersion ?? "Unknown"} />
      <SettingsFieldRow title="Protocol" content={`v${mesh.status.protocol.negotiatedProtocolVersion ?? mesh.status.protocol.preferredProtocolVersion}`} />
      <SettingsFieldRow title="Supported" content={mesh.status.protocol.supportedProtocolVersions.map((version) => `v${version}`).join(", ")} />
    </FormGroup> : null}
  </div>;
}
