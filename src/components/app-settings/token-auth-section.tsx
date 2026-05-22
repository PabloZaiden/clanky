import { useCallback, useEffect, useMemo, useState } from "react";
import { appFetch } from "../../lib/public-path";
import { readApiError } from "../../lib/api-error";
import { useToast } from "../../hooks";
import { Button, ConfirmModal } from "../common";

interface IssuerSettingsResponse {
  canonicalIssuer: string | null;
  effectiveIssuer: string;
}

interface AuthSessionSummary {
  id: string;
  clientId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
  active: boolean;
}

function formatTimestamp(value?: string): string {
  if (!value) {
    return "Never";
  }

  return new Date(value).toLocaleString();
}

export function TokenAuthSection() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [savingIssuer, setSavingIssuer] = useState(false);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);
  const [pendingRevokeSession, setPendingRevokeSession] = useState<AuthSessionSummary | null>(null);
  const [canonicalIssuer, setCanonicalIssuer] = useState("");
  const [effectiveIssuer, setEffectiveIssuer] = useState("");
  const [sessions, setSessions] = useState<AuthSessionSummary[]>([]);
  const activeSessions = useMemo(() => sessions.filter((session) => session.active), [sessions]);

  const loadState = useCallback(async () => {
    const [issuerResponse, sessionsResponse] = await Promise.all([
      appFetch("/api/auth/issuer"),
      appFetch("/api/auth/sessions"),
    ]);

    if (!issuerResponse.ok) {
      throw new Error(await readApiError(issuerResponse));
    }
    if (!sessionsResponse.ok) {
      throw new Error(await readApiError(sessionsResponse));
    }

    const issuer = await issuerResponse.json() as IssuerSettingsResponse;
    const nextSessions = await sessionsResponse.json() as AuthSessionSummary[];
    setCanonicalIssuer(issuer.canonicalIssuer ?? "");
    setEffectiveIssuer(issuer.effectiveIssuer);
    setSessions(nextSessions);
  }, []);

  useEffect(() => {
    void loadState()
      .catch((error: unknown) => {
        toast.error(String(error));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [loadState, toast]);

  const saveIssuer = useCallback(async () => {
    setSavingIssuer(true);
    try {
      const response = await appFetch("/api/auth/issuer", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          canonicalIssuer: canonicalIssuer.trim() || null,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const body = await response.json() as IssuerSettingsResponse;
      setCanonicalIssuer(body.canonicalIssuer ?? "");
      setEffectiveIssuer(body.effectiveIssuer);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingIssuer(false);
    }
  }, [canonicalIssuer, toast]);

  const revokeSession = useCallback(async (sessionId: string) => {
    setRevokingSessionId(sessionId);
    try {
      const response = await appFetch(`/api/auth/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      await loadState();
      setPendingRevokeSession(null);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setRevokingSessionId(null);
    }
  }, [loadState, toast]);

  function handleCloseRevokeConfirm(): void {
    if (!revokingSessionId) {
      setPendingRevokeSession(null);
    }
  }

  return (
    <div>
      <h3 className="mb-4 text-sm font-medium text-gray-900 dark:text-gray-100">
        Bearer Token Authentication
      </h3>
      <div className="space-y-4 rounded-lg bg-gray-50 p-4 dark:bg-neutral-900">
        <div className="space-y-2">
          <label
            htmlFor="canonical-issuer"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Canonical issuer URL
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Set a stable public base URL when other tools need standard issuer and discovery metadata.
          </p>
          <input
            id="canonical-issuer"
            type="url"
            value={canonicalIssuer}
            onChange={(event) => setCanonicalIssuer(event.target.value)}
            placeholder="https://clanky.example.com"
            disabled={loading || savingIssuer}
            className="block w-full rounded-md border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:ring-gray-500 disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-gray-500 dark:text-gray-400 break-all">
              Effective issuer: <span className="font-mono">{effectiveIssuer || "Loading..."}</span>
            </p>
            <Button
              type="button"
              size="sm"
              loading={savingIssuer}
              disabled={loading}
              onClick={() => {
                void saveIssuer();
              }}
            >
              Save issuer
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-200">CLI sessions</h4>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Sessions created through the device flow can be revoked here without waiting for refresh-token expiry.
            </p>
          </div>

          <div className="space-y-3">
            {activeSessions.length === 0 && !loading ? (
              <div className="rounded-md border border-dashed border-gray-300 px-3 py-3 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                No active CLI sessions.
              </div>
            ) : null}

            {activeSessions.map((session) => (
              <div
                key={session.id}
                className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-neutral-800"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1 text-sm text-gray-600 dark:text-gray-300">
                    <p>
                      <strong className="text-gray-900 dark:text-gray-100">{session.clientId}</strong>
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Created: {formatTimestamp(session.createdAt)}
                      {" · "}Last used: {formatTimestamp(session.lastUsedAt)}
                      {" · "}Expires: {formatTimestamp(session.expiresAt)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    loading={revokingSessionId === session.id}
                    disabled={revokingSessionId !== null}
                    onClick={() => {
                      setPendingRevokeSession(session);
                    }}
                  >
                    Revoke
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <ConfirmModal
        isOpen={pendingRevokeSession !== null}
        onClose={handleCloseRevokeConfirm}
        onConfirm={() => {
          if (pendingRevokeSession) {
            void revokeSession(pendingRevokeSession.id);
          }
        }}
        title="Revoke CLI session?"
        message={pendingRevokeSession
          ? `Revoke the active token session for "${pendingRevokeSession.clientId}" now? The CLI will need to authenticate again once it can no longer refresh.`
          : ""}
        confirmLabel="Revoke session"
        loading={pendingRevokeSession !== null && revokingSessionId === pendingRevokeSession.id}
        variant="danger"
      />
    </div>
  );
}
