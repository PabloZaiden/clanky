/**
 * Legacy modal wrapper for workspace settings in the old dashboard flow.
 */

import { useState, useEffect } from "react";
import { Modal } from "@pablozaiden/webapp/web";
import { Button } from "../common";
import { WorkspaceSettingsForm } from "./workspace-settings-form";
import type { WorkspaceSettingsModalProps } from "./types";

export function WorkspaceSettingsModal({
  isOpen,
  onClose,
  ...props
}: WorkspaceSettingsModalProps) {
  const [isValid, setIsValid] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setIsValid(false);
    }
  }, [isOpen]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Workspace Settings"
      description={props.workspace ? `Edit settings for "${props.workspace.name}"` : "Edit workspace settings"}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={props.saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="workspace-settings-modal-form"
            loading={props.saving}
            disabled={!isValid}
          >
            Save Changes
          </Button>
        </>
      }
    >
      <WorkspaceSettingsForm
        {...props}
        formId="workspace-settings-modal-form"
        onSaved={onClose}
        onDeleted={onClose}
        onValidityChange={setIsValid}
      />
    </Modal>
  );
}
