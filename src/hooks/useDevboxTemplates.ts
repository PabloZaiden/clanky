import { useCallback, useEffect, useRef, useState } from "react";
import type { DevboxTemplateSummary } from "../types";
import { listDevboxTemplatesApi } from "./sshServerActions";

export interface UseDevboxTemplatesOptions {
  serverId: string;
  password?: string;
}

export interface UseDevboxTemplatesResult {
  templates: DevboxTemplateSummary[];
  templatesLoading: boolean;
  templatesError: string | null;
  refreshTemplates: (passwordOverride?: string) => Promise<DevboxTemplateSummary[]>;
}

export function useDevboxTemplates({
  serverId,
  password,
}: UseDevboxTemplatesOptions): UseDevboxTemplatesResult {
  const [templates, setTemplates] = useState<DevboxTemplateSummary[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const latestPasswordRef = useRef(password);

  useEffect(() => {
    latestPasswordRef.current = password;
  }, [password]);

  const refreshTemplates = useCallback(async (
    passwordOverride?: string,
  ): Promise<DevboxTemplateSummary[]> => {
    const trimmedServerId = serverId.trim();
    if (!trimmedServerId) {
      setTemplates([]);
      setTemplatesError(null);
      setTemplatesLoading(false);
      return [];
    }

    setTemplatesLoading(true);
    try {
      const nextTemplates = await listDevboxTemplatesApi({
        serverId: trimmedServerId,
        password: passwordOverride ?? latestPasswordRef.current,
      });
      setTemplates(nextTemplates);
      setTemplatesError(null);
      return nextTemplates;
    } catch (error) {
      setTemplates([]);
      setTemplatesError(error instanceof Error ? error.message : String(error));
      return [];
    } finally {
      setTemplatesLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    if (!serverId.trim()) {
      setTemplates([]);
      setTemplatesError(null);
      setTemplatesLoading(false);
      return;
    }

    void refreshTemplates();
  }, [serverId, refreshTemplates]);

  return {
    templates,
    templatesLoading,
    templatesError,
    refreshTemplates,
  };
}
