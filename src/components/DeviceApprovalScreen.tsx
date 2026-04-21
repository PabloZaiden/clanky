import { useCallback, useEffect, useMemo, useState } from "react";
import { appFetch } from "../lib/public-path";
import { Button } from "./common";

interface DeviceVerificationDetails {
  userCode: string;
  clientId: string;
  scope: string;
  status: "pending" | "approved" | "denied" | "consumed";
  expiresAt: string;
  passkeyRequired: boolean;
}

async function readApiError(response: Response): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message || data.error || `Request failed with status ${String(response.status)}`;
  } catch {
    return `Request failed with status ${String(response.status)}`;
  }
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

export interface DeviceApprovalScreenProps {
  userCode?: string;
}

export function DeviceApprovalScreen({ userCode }: DeviceApprovalScreenProps) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<DeviceVerificationDetails | null>(null);

  const loadDetails = useCallback(async () => {
    if (!userCode) {
      setError("Open the verification URL provided by the CLI so Ralpher knows which device request to approve.");
      setLoading(false);
      return;
    }

    const response = await appFetch(`/api/auth/device/verification?user_code=${encodeURIComponent(userCode)}`);
    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    setDetails(await response.json() as DeviceVerificationDetails);
  }, [userCode]);

  useEffect(() => {
    void loadDetails()
      .catch((loadError: unknown) => {
        setError(String(loadError));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [loadDetails]);

  const submitDecision = useCallback(async (action: "approve" | "deny") => {
    if (!details) {
      return;
    }

    setSubmitting(action);
    setError(null);
    try {
      const response = await appFetch(`/api/auth/device/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userCode: details.userCode,
        }),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      setDetails(await response.json() as DeviceVerificationDetails);
    } catch (submitError) {
      setError(String(submitError));
    } finally {
      setSubmitting(null);
    }
  }, [details]);

  const statusMessage = useMemo(() => {
    if (!details) {
      return null;
    }
    if (details.status === "approved") {
      return "This device request is approved. The CLI can finish exchanging the device code now.";
    }
    if (details.status === "consumed") {
      return "This device request has already been completed and its tokens were issued.";
    }
    if (details.status === "denied") {
      return "This device request was denied.";
    }
    return "Approve this request to issue bearer credentials for the CLI.";
  }, [details]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100 px-4 py-10 text-gray-950 dark:bg-neutral-950 dark:text-gray-100">
      <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">
            Device authorization
          </p>
          <h1 className="text-2xl font-semibold">Approve CLI access</h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Review the pending device request and decide whether this CLI can use bearer credentials as an alternative to your browser passkey session.
          </p>
        </div>

        <div className="mt-6 space-y-4">
          {loading ? (
            <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-gray-400">
              Loading device request…
            </div>
          ) : null}

          {details ? (
            <div className="space-y-3 rounded-lg bg-gray-50 p-4 text-sm text-gray-700 dark:bg-neutral-950 dark:text-gray-200">
              <p><strong>User code:</strong> <span className="font-mono">{details.userCode}</span></p>
              <p><strong>Client:</strong> {details.clientId}</p>
              <p><strong>Scope:</strong> {details.scope || "(none requested)"}</p>
              <p><strong>Expires:</strong> {formatTimestamp(details.expiresAt)}</p>
              <p>{statusMessage}</p>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              className="flex-1"
              loading={submitting === "approve"}
              disabled={!details || details.status !== "pending"}
              onClick={() => {
                void submitDecision("approve");
              }}
            >
              Approve
            </Button>
            <Button
              type="button"
              className="flex-1"
              variant="secondary"
              loading={submitting === "deny"}
              disabled={!details || details.status !== "pending"}
              onClick={() => {
                void submitDecision("deny");
              }}
            >
              Deny
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
