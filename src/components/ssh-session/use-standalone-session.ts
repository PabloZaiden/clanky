/**
 * Hook for managing standalone (direct SSH) session credential state and server info.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSshServerApi } from "../../hooks";
import { getStoredSshCredentialToken } from "../../lib/ssh-browser-credentials";
import type { SshServer } from "@/shared";
import type { SshSessionKind } from "../../hooks/useSshSession";
import { isStandaloneSession, type SshSession } from "./session-utils";

interface UseStandaloneSessionParams {
  session: SshSession | null;
  sessionKind: SshSessionKind | null;
  showErrorToast: (message: string) => void;
}

export function useStandaloneSession({
  session,
  sessionKind,
  showErrorToast,
}: UseStandaloneSessionParams) {
  const [standaloneServer, setStandaloneServer] = useState<SshServer | null>(null);
  const [standalonePassword, setStandalonePassword] = useState("");
  const [standaloneCredentialToken, setStandaloneCredentialToken] = useState<string | null>(null);
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [pendingStandaloneAction, setPendingStandaloneAction] = useState<"terminal" | "delete" | null>(null);
  const standaloneCredentialTokenRef = useRef<string | null>(null);
  const pendingStandaloneActionRef = useRef<"terminal" | "delete" | null>(null);

  useEffect(() => {
    standaloneCredentialTokenRef.current = standaloneCredentialToken;
  }, [standaloneCredentialToken]);

  useEffect(() => {
    pendingStandaloneActionRef.current = pendingStandaloneAction;
  }, [pendingStandaloneAction]);

  useEffect(() => {
    if (sessionKind !== "standalone") {
      setStandaloneCredentialToken(null);
      setShowPasswordPrompt(false);
      setPendingStandaloneAction(null);
    }
  }, [sessionKind]);

  const standaloneServerId = useMemo(() => {
    if (!session || !isStandaloneSession(session)) {
      return null;
    }
    return session.config.sshServerId;
  }, [session]);

  const standaloneServerName = useMemo(() => {
    if (!standaloneServerId) {
      return null;
    }
    return standaloneServer?.config.name ?? standaloneServerId;
  }, [standaloneServer, standaloneServerId]);

  const standaloneServerTarget = useMemo(() => {
    if (!standaloneServerId) {
      return null;
    }
    return standaloneServer
      ? `${standaloneServer.config.username}@${standaloneServer.config.address}`
      : standaloneServerId;
  }, [standaloneServer, standaloneServerId]);

  useEffect(() => {
    let cancelled = false;

    async function loadStandaloneServer() {
      if (!standaloneServerId) {
        setStandaloneServer(null);
        return;
      }
      try {
        const server = await getSshServerApi(standaloneServerId);
        if (!cancelled) {
          setStandaloneServer(server);
        }
      } catch (error) {
        if (!cancelled) {
          setStandaloneServer(null);
          showErrorToast(`Failed to load SSH server details: ${String(error)}`);
        }
      }
    }

    void loadStandaloneServer();

    return () => {
      cancelled = true;
    };
  }, [showErrorToast, standaloneServerId]);

  const loadStandaloneCredentialToken = useCallback(async (
    options?: { forceRefresh?: boolean; promptOnFailure?: boolean },
  ): Promise<string | null> => {
    if (!standaloneServerId) {
      setStandaloneCredentialToken(null);
      return null;
    }

    if (!options?.forceRefresh && standaloneCredentialTokenRef.current) {
      return standaloneCredentialTokenRef.current;
    }

    try {
      const token = await getStoredSshCredentialToken(standaloneServerId);
      setStandaloneCredentialToken(token);
      if (token) {
        if (pendingStandaloneActionRef.current !== "delete") {
          setShowPasswordPrompt(false);
          setPendingStandaloneAction(null);
        }
        return token;
      }
      if ((options?.promptOnFailure ?? true) && pendingStandaloneActionRef.current !== "delete") {
        setPendingStandaloneAction("terminal");
        setShowPasswordPrompt(true);
      }
      return null;
    } catch (error) {
      setStandaloneCredentialToken(null);
      showErrorToast(`Failed to refresh the stored SSH credential: ${String(error)}`);
      if ((options?.promptOnFailure ?? true) && pendingStandaloneActionRef.current !== "delete") {
        setPendingStandaloneAction("terminal");
        setShowPasswordPrompt(true);
      }
      return null;
    }
  }, [showErrorToast, standaloneServerId]);

  return {
    standaloneServerId,
    standaloneServer,
    standaloneServerName,
    standaloneServerTarget,
    standalonePassword,
    setStandalonePassword,
    standaloneCredentialToken,
    setStandaloneCredentialToken,
    standaloneCredentialTokenRef,
    showPasswordPrompt,
    setShowPasswordPrompt,
    pendingStandaloneAction,
    setPendingStandaloneAction,
    pendingStandaloneActionRef,
    loadStandaloneCredentialToken,
  };
}
