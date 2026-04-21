import { useState } from "react";
import type { PasskeyAuthStatusResponse } from "../../types/api";
import { Button } from "../common";

export interface PasskeyAuthSectionProps {
  status: PasskeyAuthStatusResponse;
  registering?: boolean;
  loggingOut?: boolean;
  removingPasskey?: boolean;
  refreshing?: boolean;
  onRegisterPasskey?: (name?: string) => Promise<boolean>;
  onLogout?: () => Promise<boolean>;
}

export function PasskeyAuthSection({
  status,
  registering = false,
  loggingOut = false,
  removingPasskey = false,
  refreshing = false,
  onRegisterPasskey,
  onLogout,
}: PasskeyAuthSectionProps) {
  const [passkeyName, setPasskeyName] = useState("");

  return (
    <div>
      <h3 className="mb-4 text-sm font-medium text-gray-900 dark:text-gray-100">
        Passkey Authentication
      </h3>
      <div className="space-y-4 rounded-lg bg-gray-50 p-4 dark:bg-neutral-900">
        <div className="space-y-1 text-sm text-gray-600 dark:text-gray-300">
          <p>
            Passkeys protect the in-app browser session. Bearer tokens are issued through the device flow as an equivalent API authentication option.
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Current state:{" "}
            <strong className="font-medium text-gray-700 dark:text-gray-200">
              {status.passkeyConfigured ? "configured" : "not configured"}
            </strong>
            {status.passkeyRequired ? ", login required" : ", login not required"}
            {status.authenticated ? ", this browser is logged in" : ", this browser is logged out"}
            .
          </p>
        </div>

        {status.passkeyDisabled ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            Passkey enforcement is bypassed by <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs dark:bg-amber-900/50">RALPHER_DISABLE_PASSKEY</code>.
          </div>
        ) : null}

        {!status.passkeyConfigured ? (
          <div className="space-y-3">
            <div>
              <label
                htmlFor="passkey-name"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Passkey name
              </label>
              <input
                id="passkey-name"
                type="text"
                value={passkeyName}
                onChange={(event) => setPasskeyName(event.target.value)}
                placeholder="Primary passkey"
                className="block w-full rounded-md border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:ring-gray-500 disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100"
                disabled={registering || refreshing}
              />
            </div>
            <Button
              type="button"
              size="sm"
              loading={registering}
              disabled={!onRegisterPasskey || refreshing}
              onClick={() => {
                void onRegisterPasskey?.(passkeyName);
              }}
            >
              Register passkey
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              loading={loggingOut}
              disabled={!status.authenticated || !onLogout || removingPasskey || refreshing}
              onClick={() => {
                void onLogout?.();
              }}
            >
              Logout
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
