import { useEffect, useId, useState, type FormEvent } from "react";
import type { SshServer } from "@/shared";
import type { CreateSshServerRequest, UpdateSshServerRequest } from "@/contracts";
import { Button } from "../common";
import { useHeaderActions, useToast, type WebAppRoute } from "@pablozaiden/webapp/web";
import { SshServerFields } from "./ssh-server-fields";
import {
  buildSshServerUpdateRequest,
  createSshServerFormValues,
  trimSshServerFormValues,
  type SshServerFormValues,
} from "./ssh-server-form-utils";

interface SshServerComposerProps {
  initialServer?: SshServer | null;
  onNavigate: (route: WebAppRoute) => void;
  onCreateServer: (request: CreateSshServerRequest, password?: string) => Promise<SshServer | null>;
  onUpdateServer: (id: string, request?: UpdateSshServerRequest, password?: string) => Promise<SshServer | null>;
}

export function SshServerComposer({
  initialServer,
  onNavigate,
  onCreateServer,
  onUpdateServer,
}: SshServerComposerProps) {
  const toast = useToast();
  const formId = useId();
  const isEditing = Boolean(initialServer);
  const [values, setValues] = useState<SshServerFormValues>(() => createSshServerFormValues(initialServer));
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setValues(createSshServerFormValues(initialServer));
  }, [
    initialServer?.config.id,
    initialServer?.config.name,
    initialServer?.config.address,
    initialServer?.config.username,
    initialServer?.config.repositoriesBasePath,
  ]);

  function handleChange(field: keyof SshServerFormValues, value: string) {
    setValues((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextValues = trimSshServerFormValues(values);

    if (!nextValues.name || !nextValues.address || !nextValues.username) {
      toast.error("Name, address, and username are required.");
      return;
    }

    if (initialServer) {
      const request = buildSshServerUpdateRequest(initialServer, nextValues);
      const hasChanges = Boolean(request) || Boolean(nextValues.password);

      if (!hasChanges) {
        onNavigate({
          view: "execution-host",
          hostKind: "ssh",
          hostId: initialServer.config.id,
        });
        return;
      }
    }

    setSubmitting(true);
    try {
      const updateRequest = initialServer ? buildSshServerUpdateRequest(initialServer, nextValues) : undefined;
      const server = initialServer
        ? await onUpdateServer(
          initialServer.config.id,
          updateRequest,
          nextValues.password,
        )
        : await onCreateServer(
          {
            name: nextValues.name,
            address: nextValues.address,
            username: nextValues.username,
            repositoriesBasePath: nextValues.repositoriesBasePath ?? null,
          },
          nextValues.password,
        );

      if (!server) {
        toast.error(initialServer ? "Failed to update SSH server" : "Failed to create SSH server");
        return;
      }
      onNavigate({
        view: "execution-host",
        hostKind: "ssh",
        hostId: server.config.id,
      });
    } finally {
      setSubmitting(false);
    }
  }

  useHeaderActions({
    primary: (
      <Button type="submit" form={formId} size="sm" loading={submitting}>
        {isEditing ? "Save" : "Create"}
      </Button>
    ),
  });

  return (
    <form id={formId} className="space-y-6" onSubmit={(event) => void handleSubmit(event)}>
      <SshServerFields
        values={values}
        onChange={handleChange}
        isEditing={isEditing}
        relatedSessionCount={0}
        disabled={submitting}
      />
    </form>
  );
}
