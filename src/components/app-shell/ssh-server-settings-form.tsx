import { useEffect, useState, type FormEvent } from "react";
import { useToast } from "../../hooks";
import type { SshServer, UpdateSshServerRequest } from "../../types";
import { DeleteSshServerSection } from "./delete-ssh-server-section";
import { SshServerFields } from "./ssh-server-fields";
import {
  buildSshServerUpdateRequest,
  createSshServerFormValues,
  trimSshServerFormValues,
  type SshServerFormValues,
} from "./ssh-server-form-utils";

interface SshServerSettingsFormProps {
  server: SshServer;
  relatedSessionCount: number;
  formId?: string;
  onSave: (
    id: string,
    request?: UpdateSshServerRequest,
    password?: string,
  ) => Promise<SshServer | null>;
  onDeleteServer: () => Promise<boolean>;
  onSaved?: () => void;
  onDeleted?: () => void;
  onValidityChange?: (isValid: boolean) => void;
  onSubmittingChange?: (isSubmitting: boolean) => void;
}

export function SshServerSettingsForm({
  server,
  relatedSessionCount,
  formId = "ssh-server-settings-form",
  onSave,
  onDeleteServer,
  onSaved,
  onDeleted,
  onValidityChange,
  onSubmittingChange,
}: SshServerSettingsFormProps) {
  const toast = useToast();
  const [values, setValues] = useState<SshServerFormValues>(() => createSshServerFormValues(server));
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setValues(createSshServerFormValues(server));
  }, [server]);

  const trimmedValues = trimSshServerFormValues(values);
  const isValid = Boolean(trimmedValues.name && trimmedValues.address && trimmedValues.username);

  useEffect(() => {
    onValidityChange?.(isValid);
  }, [isValid, onValidityChange]);

  useEffect(() => {
    onSubmittingChange?.(submitting);
  }, [submitting, onSubmittingChange]);

  function handleChange(field: keyof SshServerFormValues, value: string) {
    setValues((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!isValid) {
      toast.error("Name, address, and username are required.");
      return;
    }

    const request = buildSshServerUpdateRequest(server, trimmedValues);
    if (!request && !trimmedValues.password) {
      toast.success("SSH server is already up to date.");
      onSaved?.();
      return;
    }

    setSubmitting(true);
    let shouldNotifySaved = false;
    try {
      const updatedServer = await onSave(server.config.id, request, trimmedValues.password);
      if (!updatedServer) {
        toast.error("Failed to update SSH server");
        return;
      }

      toast.success(`Saved SSH server "${updatedServer.config.name}"`);
      shouldNotifySaved = true;
    } finally {
      setSubmitting(false);
    }

    if (shouldNotifySaved) {
      onSaved?.();
    }
  }

  return (
    <>
      <form id={formId} className="space-y-6" onSubmit={(event) => void handleSubmit(event)}>
        <SshServerFields
          values={values}
          onChange={handleChange}
          isEditing
          relatedSessionCount={relatedSessionCount}
          disabled={submitting}
        />
      </form>

      <DeleteSshServerSection
        server={server}
        relatedSessionCount={relatedSessionCount}
        disabled={submitting}
        onDeleteServer={onDeleteServer}
        onDeleted={onDeleted}
      />
    </>
  );
}
