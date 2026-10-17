import { useState, type FormEvent } from "react";
import { CodeValue, FormActions, SelectField, TextField, useToast } from "@pablozaiden/webapp/web";
import type { MeshEnrollmentRoute } from "@/contracts/schemas/mesh";
import type { UseMeshResult } from "../../hooks";
import { Button } from "../common";
import { SettingsError } from "./settings-row-controls";

export function MeshEnrollmentForm({ mesh, onClose }: { mesh: UseMeshResult; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("Mesh worker");
  const [route, setRoute] = useState<MeshEnrollmentRoute>("direct");
  const [relayName, setRelayName] = useState("");
  const [created, setCreated] = useState<{ workerJoinCommand: string } | null>(null);
  const relayUnavailable = Boolean(
    relayName && mesh.relayStatus
    && !mesh.relayStatus.relays.some((relay) => relay.name === relayName),
  );

  async function createToken(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const result = await mesh.createEnrollmentToken(
      name,
      900,
      route,
      route === "relay" && relayName ? relayName : undefined,
    );
    if (!result) return;
    setCreated(result);
    toast.success("Worker enrollment token created.");
  }

  return (
    created ? <>
      <CodeValue label="Worker enrollment command" value={created.workerJoinCommand} />
      <FormActions><Button onClick={onClose}>Done</Button></FormActions>
    </> :
      <form className="grid gap-3" onSubmit={(event) => void createToken(event)}>
        <TextField
          id="mesh-enrollment-name"
          label="Name"
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          disabled={mesh.saving}
        />
        <SelectField
          id="mesh-enrollment-route"
          label="Route"
          value={route}
          onChange={(event) => setRoute(event.currentTarget.value as MeshEnrollmentRoute)}
          disabled={mesh.saving}
        >
          <option value="direct">Direct</option>
          <option value="relay">Relay</option>
        </SelectField>
        {route === "relay" ? (
          <SelectField
            id="mesh-enrollment-relay"
            label="Relay"
            value={relayName}
            onChange={(event) => setRelayName(event.currentTarget.value)}
            disabled={mesh.saving || mesh.relayStatusLoading}
          >
            <option value="">
              {mesh.relayStatus?.primaryName
                ? `Primary (${mesh.relayStatus.primaryName})`
                : "No primary relay selected"}
            </option>
            {relayUnavailable ? (
              <option value={relayName} disabled>{relayName} (no longer paired)</option>
            ) : null}
            {mesh.relayStatus?.relays.map((relay) => (
              <option key={relay.name} value={relay.name}>{relay.name}</option>
            ))}
          </SelectField>
        ) : null}
        {relayUnavailable ? <SettingsError>Choose a paired relay before creating a token.</SettingsError> : null}
        <FormActions>
          <Button onClick={onClose} disabled={mesh.saving}>Cancel</Button>
          <Button type="submit" size="sm" variant="primary" loading={mesh.saving} disabled={relayUnavailable || mesh.saving}>
            Create
          </Button>
        </FormActions>
      </form>
  );
}
