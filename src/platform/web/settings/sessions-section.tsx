import { useCallback, useState } from "react";
import type { AuthSessionSummary, WebAppConfigResponse } from "../../contracts";
import { appJson } from "../api-client";
import { ActionMenu, ConfirmDialog, EmptyState } from "@pablozaiden/webapp/web";
import { DateTimeValue } from "@pablozaiden/webapp/web";
import { SettingsFieldRow } from "@pablozaiden/webapp/web";
import { useLiveQuery } from "@pablozaiden/webapp/web";
import { ResourceState } from "./resource-state";

export interface SessionsSectionProps {
  config: WebAppConfigResponse;
  setError: (error: string | undefined) => void;
}

export function SessionsSection({ config }: SessionsSectionProps) {
  const [error, setError] = useState<string>();
  const [authSessionToRevoke, setAuthSessionToRevoke] = useState<AuthSessionSummary>();

  const loadAuthSessions = useCallback(
    () => config.deviceAuth.enabled
      ? appJson<AuthSessionSummary[]>("/api/auth/sessions")
      : Promise.resolve<AuthSessionSummary[]>([]),
    [config.deviceAuth.enabled],
  );
  const { data: authSessions, error: authSessionsLoadError, loading: authSessionsLoading, refresh: refreshAuthSessions } = useLiveQuery<AuthSessionSummary[]>({ load: loadAuthSessions, realtime: false });

  async function revokeAuthSession(session: AuthSessionSummary) {
    try {
      setError(undefined);
      await appJson(`/api/auth/sessions/${session.id}`, { method: "DELETE" });
      setAuthSessionToRevoke(undefined);
      await refreshAuthSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!config.deviceAuth.enabled) {
    return null;
  }
  return (
    <>
      <SettingsFieldRow title="Device sessions" />
        <ResourceState loading={authSessionsLoading} error={authSessionsLoadError} hasData={authSessions !== undefined} refresh={refreshAuthSessions} />
        <div className="wapp-list">
          {authSessions?.length ? authSessions.map((session) => (
            <div className="wapp-list-row" key={session.id}>
              <span><strong>Device session</strong><small>{session.scope} · <DateTimeValue value={session.updatedAt} /></small></span>
              <ActionMenu ariaLabel="Device session actions" items={[{ label: "Revoke session", destructive: true, onAction: () => setAuthSessionToRevoke(session) }]} />
            </div>
          )) : authSessions !== undefined && !authSessionsLoadError ? <EmptyState title="No device sessions" /> : null}
        </div>
      {error ? <p className="wapp-error" role="alert">{error}</p> : null}
      <ConfirmDialog
        open={Boolean(authSessionToRevoke)}
        title="Revoke device session?"
        message="This device will lose access."
        confirmLabel="Revoke session"
        danger
        onCancel={() => setAuthSessionToRevoke(undefined)}
        onConfirm={() => authSessionToRevoke && void revokeAuthSession(authSessionToRevoke)}
      />
    </>
  );
}
