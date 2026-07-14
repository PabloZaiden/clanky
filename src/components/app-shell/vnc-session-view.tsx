import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { SshServer, VncSession } from "@/shared";
import { useToast } from "../../hooks";
import { closeVncSessionApi, createOrResumeVncSessionApi, listVncSessionsApi } from "../../hooks/sshServerActions";
import { getStoredSshServerCredential, storeSshServerPassword } from "../../lib/ssh-browser-credentials";
import { getStoredVncCredentials, storeVncCredentials } from "../../lib/vnc-browser-credentials";
import { isApiErrorCode } from "../../lib/api-error";
import { Button } from "../common";
import { ErrorState, FormGroup, Panel, TextField, type WebAppRoute } from "@pablozaiden/webapp/web";
import { EmptySection } from "./shell-sidebar";
import { VncViewer } from "./VncViewer";
import { ServerPasswordModal } from "./server-password-modal";

const DEFAULT_VNC_PORT = 5900;

function getVncPortStorageKey(serverId: string): string {
  return `clanky:vnc:${serverId}:remotePort`;
}

function getInitialRemotePort(serverId: string): string {
  if (typeof window === "undefined") {
    return String(DEFAULT_VNC_PORT);
  }
  return window.localStorage.getItem(getVncPortStorageKey(serverId)) ?? String(DEFAULT_VNC_PORT);
}

export function VncSessionView({
  server,
  onNavigate,
}: {
  server: SshServer;
  onNavigate: (route: WebAppRoute) => void;
}) {
  const toast = useToast();
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const vncPasswordInputRef = useRef<HTMLInputElement>(null);
  const [sessions, setSessions] = useState<VncSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [remotePort, setRemotePort] = useState(() => getInitialRemotePort(server.config.id));
  const [vncUsername, setVncUsername] = useState(server.config.username);
  const [vncPassword, setVncPassword] = useState("");
  const [serverPasswordModalOpen, setServerPasswordModalOpen] = useState(false);
  const [serverPassword, setServerPassword] = useState("");
  const [serverPasswordError, setServerPasswordError] = useState<string | null>(null);
  const [serverPasswordSubmitting, setServerPasswordSubmitting] = useState(false);
  const [vncError, setVncError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fullscreenActive, setFullscreenActive] = useState(false);

  const refreshSessions = useCallback(async () => {
    try {
      const nextSessions = await listVncSessionsApi(server.config.id);
      setSessions(nextSessions);
    } catch (error) {
      toast.error(String(error));
    }
  }, [server.config.id, toast]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    let cancelled = false;
    setActiveSessionId(null);
    setRemotePort(getInitialRemotePort(server.config.id));
    setVncUsername(server.config.username);
    setVncPassword("");
    setVncError(null);
    void (async () => {
      try {
        const storedCredentials = await getStoredVncCredentials(server.config.id);
        if (!cancelled && storedCredentials !== null) {
          if (storedCredentials.username !== undefined) {
            setVncUsername(storedCredentials.username);
          } else {
            setVncUsername("");
          }
          setVncPassword(storedCredentials.password);
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
  }, [server.config.id, server.config.username, toast]);

  useEffect(() => {
    function handleFullscreenChange() {
      setFullscreenActive(document.fullscreenElement === fullscreenRef.current);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const connectedSession = useMemo(() => {
    return sessions.find((session) => session.state.status === "active") ?? null;
  }, [sessions]);
  const activeSession = sessions.find((session) => session.config.id === activeSessionId) ?? connectedSession;

  const startVncSession = useCallback(async (parsedPort: number) => {
    setBusy(true);
    try {
      window.localStorage.setItem(getVncPortStorageKey(server.config.id), String(parsedPort));
      const trimmedVncPassword = vncPassword.trim();
      if (trimmedVncPassword) {
        await storeVncCredentials(server.config.id, {
          username: vncUsername,
          password: trimmedVncPassword,
        });
      }
      const session = await createOrResumeVncSessionApi({
        serverId: server.config.id,
        remotePort: parsedPort,
      });
      setVncError(null);
      setActiveSessionId(session.config.id);
      await refreshSessions();
    } catch (error) {
      if (
        isApiErrorCode(error, "invalid_credential_token")
        || isApiErrorCode(error, "ssh_credential_required")
        || isApiErrorCode(error, "ssh_credential_invalid")
      ) {
        setServerPasswordModalOpen(true);
        setServerPasswordError(error instanceof Error ? error.message : String(error));
        return;
      }
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }, [refreshSessions, server.config.id, toast, vncPassword, vncUsername]);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedPort = Number.parseInt(remotePort, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      toast.error("Enter a valid VNC port.");
      return;
    }

    if (!getStoredSshServerCredential(server.config.id)) {
      setServerPasswordModalOpen(true);
      setServerPasswordError(null);
      return;
    }

    await startVncSession(parsedPort);
  }, [remotePort, server.config.id, startVncSession, toast]);

  const handleCloseServerPasswordModal = useCallback(() => {
    if (serverPasswordSubmitting) {
      return;
    }
    setServerPasswordModalOpen(false);
    setServerPassword("");
    setServerPasswordError(null);
  }, [serverPasswordSubmitting]);

  const handleSubmitServerPassword = useCallback(async () => {
    const trimmedPassword = serverPassword.trim();
    if (!trimmedPassword) {
      setServerPasswordError("Enter the SSH password for this server.");
      return;
    }

    const parsedPort = Number.parseInt(remotePort, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setServerPasswordError("Enter a valid VNC port before continuing.");
      return;
    }

    try {
      setServerPasswordSubmitting(true);
      setServerPasswordError(null);
      await storeSshServerPassword(server.config.id, trimmedPassword);
      setServerPassword("");
      setServerPasswordModalOpen(false);
      await startVncSession(parsedPort);
    } catch (error) {
      setServerPasswordError(error instanceof Error ? error.message : String(error));
    } finally {
      setServerPasswordSubmitting(false);
    }
  }, [remotePort, server.config.id, serverPassword, startVncSession]);

  const closeVnc = useCallback(async () => {
    if (!activeSession) {
      return;
    }
    setBusy(true);
    try {
      await closeVncSessionApi(activeSession.config.id);
      setActiveSessionId(null);
      await refreshSessions();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }, [activeSession, refreshSessions, toast]);

  const toggleFullscreen = useCallback(async () => {
    if (!fullscreenRef.current) {
      return;
    }
    try {
      if (document.fullscreenElement === fullscreenRef.current) {
        await document.exitFullscreen();
        return;
      }
      await fullscreenRef.current.requestFullscreen();
    } catch (error) {
      toast.error(String(error));
    }
  }, [toast]);

  const handleVncCredentialsRequired = useCallback(() => {
    setVncError("Enter the VNC credentials, then reconnect the VNC session.");
    vncPasswordInputRef.current?.focus();
  }, []);

  return (
    <Panel
      className="flex h-full min-h-0 flex-col overflow-hidden !border-0 !bg-transparent !p-0"
      actions={(
        <Button variant="secondary" size="sm" onClick={() => onNavigate({ view: "ssh-server", serverId: server.config.id })}>
          Back to server
        </Button>
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-5 sm:px-6 sm:py-5 lg:px-8 lg:py-6">
      <form onSubmit={(event) => void handleSubmit(event)} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-neutral-900">
        <FormGroup title="VNC connection">
          <TextField
            label="VNC port"
            type="number"
            min={1}
            max={65535}
            value={remotePort}
            onChange={(event) => setRemotePort(event.target.value)}
          />

          <TextField
            label="VNC username"
            type="text"
            value={vncUsername}
            onChange={(event) => setVncUsername(event.target.value)}
            autoComplete="username"
          />

          <label className="wapp-field">
            <span>VNC password</span>
            <input
              ref={vncPasswordInputRef}
              type="password"
              value={vncPassword}
              onChange={(event) => setVncPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>

          <div className="flex flex-wrap items-end gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Starting..." : activeSession ? "Reconnect VNC Session" : "Start VNC Session"}
            </Button>
            {activeSession && (
              <Button type="button" variant="secondary" onClick={toggleFullscreen} disabled={activeSession.state.status !== "active"}>
                {fullscreenActive ? "Exit Full Screen" : "Full Screen"}
              </Button>
            )}
            {activeSession && (
              <Button type="button" variant="secondary" onClick={closeVnc} disabled={busy}>
                Close VNC Connection
              </Button>
            )}
          </div>
          {vncError && (
            <ErrorState title="VNC connection error" description={vncError} />
          )}
        </FormGroup>
      </form>

      <div
        ref={fullscreenRef}
        className="min-h-[24rem] flex-1 rounded-lg bg-black p-0 data-[fullscreen=true]:h-screen data-[fullscreen=true]:w-screen data-[fullscreen=true]:rounded-none"
        data-fullscreen={fullscreenActive ? "true" : "false"}
      >
        {activeSession?.state.status === "active" ? (
          <VncViewer
            session={activeSession}
            username={vncUsername}
            password={vncPassword || undefined}
            fullscreen={fullscreenActive}
            onCredentialsRequired={handleVncCredentialsRequired}
            onDisconnect={() => void refreshSessions()}
            onError={setVncError}
          />
        ) : activeSession ? (
          <EmptySection message={`VNC session is ${activeSession.state.status}. Start or reconnect to open the viewer.`} />
        ) : (
          <EmptySection message="Start a VNC session to open the remote display." />
        )}
      </div>
      <ServerPasswordModal
        isOpen={serverPasswordModalOpen}
        serverName={server.config.name}
        description={`Enter the SSH password for ${server.config.name} before starting the VNC session.`}
        password={serverPassword}
        error={serverPasswordError}
        submitting={serverPasswordSubmitting}
        onPasswordChange={setServerPassword}
        onClose={handleCloseServerPasswordModal}
        onSubmit={handleSubmitServerPassword}
      />
      </div>
    </Panel>
  );
}
