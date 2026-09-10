import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ExecutionHostRef, SshServer } from "@/shared";
import type { UpdateSshServerRequest } from "@/contracts";
import { useToast } from "@pablozaiden/webapp/web";
import { DeleteSshServerSection } from "./delete-ssh-server-section";
import { ExecutionHostPrerequisitesSection } from "./execution-host-prerequisites-section";
import { SshServerFields } from "./ssh-server-fields";
import { useExecutionHostPrerequisites } from "./use-execution-host-prerequisites";
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
  onPrerequisitesChange?: (state: {
    checking: boolean;
    check: () => Promise<void>;
  } | null) => void;
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
  onPrerequisitesChange,
}: SshServerSettingsFormProps) {
  const toast = useToast();
  const [values, setValues] = useState<SshServerFormValues>(() => createSshServerFormValues(server));
  const [submitting, setSubmitting] = useState(false);
  const trimmedValues = trimSshServerFormValues(values);
  const executionHost = useMemo<ExecutionHostRef>(() => ({
    kind: "ssh",
    serverId: server.config.id,
  }), [server.config.id]);
  const prerequisites = useExecutionHostPrerequisites({
    executionHost,
    password: trimmedValues.password,
  });

  useEffect(() => {
    setValues(createSshServerFormValues(server));
  }, [server]);

  const isValid = Boolean(trimmedValues.name && trimmedValues.address && trimmedValues.username);

  useEffect(() => {
    onValidityChange?.(isValid);
  }, [isValid, onValidityChange]);

  useEffect(() => {
    onSubmittingChange?.(submitting);
  }, [submitting, onSubmittingChange]);

  useEffect(() => {
    onPrerequisitesChange?.({
      checking: prerequisites.checking,
      check: prerequisites.check,
    });
    return () => onPrerequisitesChange?.(null);
  }, [onPrerequisitesChange, prerequisites.check, prerequisites.checking]);

  function handleChange(field: keyof SshServerFormValues, value: string) {
    prerequisites.reset();
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

      <ExecutionHostPrerequisitesSection
        error={prerequisites.error}
        report={prerequisites.report}
      />

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
