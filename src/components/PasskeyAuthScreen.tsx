import { Button } from "./common";

export interface PasskeyAuthScreenProps {
  loading: boolean;
  authenticating: boolean;
  error: string | null;
  onAuthenticate: () => Promise<boolean>;
}

export function PasskeyAuthScreen({
  loading,
  authenticating,
  error,
  onAuthenticate,
}: PasskeyAuthScreenProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100 px-4 py-10 text-gray-950 dark:bg-neutral-950 dark:text-gray-100">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">
            Passkey login
          </p>
          <h1 className="text-2xl font-semibold">Unlock Ralpher</h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            This browser needs a valid passkey session before it can access the app.
          </p>
        </div>

        <div className="mt-6 space-y-4">
          <Button
            type="button"
            className="w-full"
            loading={authenticating || loading}
            onClick={() => {
              void onAuthenticate();
            }}
          >
            Continue with passkey
          </Button>

          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
