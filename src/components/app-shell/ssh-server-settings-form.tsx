import { useEffect, useState, type FormEvent } from "react";
import { useToast } from "../../hooks";
import { getStoredSshServerPassword } from "../../lib/ssh-browser-credentials";
import type { SshServer, SshServerPrerequisiteReport, UpdateSshServerRequest } from "../../types";
import { checkSshServerPrerequisitesApi } from "../../hooks/sshServerActions";
import { DeleteSshServerSection } from "./delete-ssh-server-section";
import { SshServerPrerequisitesSection } from "./ssh-server-prerequisites-section";
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
  const [checkingPrerequisites, setCheckingPrerequisites] = useState(false);
  const [prerequisiteReport, setPrerequisiteReport] = useState<SshServerPrerequisiteReport | null>(null);
  const [prerequisiteError, setPrerequisiteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setValues(createSshServerFormValues(server));
    setPrerequisiteReport(null);
    setPrerequisiteError(null);
    void (async () => {
      try {
        const storedPassword = await getStoredSshServerPassword(server.config.id);
        if (!cancelled && storedPassword !== null) {
          setValues((current) => ({
            ...current,
            password: storedPassword,
          }));
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [server, toast]);

  const trimmedValues = trimSshServerFormValues(values);
  const isValid = Boolean(trimmedValues.name && trimmedValues.address && trimmedValues.username);

  useEffect(() => {
    onValidityChange?.(isValid);
  }, [isValid, onValidityChange]);

  useEffect(() => {
    onSubmittingChange?.(submitting);
  }, [submitting, onSubmittingChange]);

  function handleChange(field: keyof SshServerFormValues, value: string) {
    setPrerequisiteReport(null);
    setPrerequisiteError(null);
    setValues((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function handleCheckPrerequisites() {
    setCheckingPrerequisites(true);
    setPrerequisiteError(null);
    try {
      const report = await checkSshServerPrerequisitesApi({
        serverId: server.config.id,
        password: trimSshServerFormValues(values).password,
      });
      setPrerequisiteReport(report);
    } catch (error) {
      setPrerequisiteReport(null);
      setPrerequisiteError(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingPrerequisites(false);
    }
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

      <SshServerPrerequisitesSection
        checking={checkingPrerequisites}
        error={prerequisiteError}
        report={prerequisiteReport}
        onCheck={handleCheckPrerequisites}
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
