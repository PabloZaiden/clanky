import { useState } from "react";
import { Button, FormActions, Modal } from "@pablozaiden/webapp/web";
import type { UseMeshResult } from "../../hooks";
import { MeshSettingsContent } from "./mesh-settings-content";
import { MeshEnrollmentForm } from "./mesh-enrollment-form";

export function WorkersSettingsSection({ mesh }: { mesh: UseMeshResult }) {
  const [enrolling, setEnrolling] = useState(false);
  return <>
    <FormActions>
      <Button loading={mesh.saving} disabled={mesh.saving} onClick={() => void mesh.checkHealth()}>Check health</Button>
      <Button variant="primary" onClick={() => setEnrolling(true)}>Enroll worker</Button>
    </FormActions>
    <MeshSettingsContent mesh={mesh} />
    <Modal isOpen={enrolling} onClose={() => { if (!mesh.saving) setEnrolling(false); }} title="Enroll worker">
      {enrolling ? <MeshEnrollmentForm mesh={mesh} onClose={() => setEnrolling(false)} /> : null}
    </Modal>
  </>;
}
