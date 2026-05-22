/** Danger Zone section: reset all settings and kill server. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../common";
import { useCountdownReload, type PurgeTerminalTasksResult } from "../../hooks";
import { RemovePasskeySection } from "./remove-passkey-section";

/** The exact phrase the user must type to confirm a full reset. */
const RESET_CONFIRMATION_PHRASE = "EXECUTE ORDER 66";

export interface DangerZoneSectionProps {
  onResetAll?: () => Promise<boolean>;
  resetting?: boolean;
  onKillServer?: () => Promise<boolean>;
  killingServer?: boolean;
  onPurgeTerminalTasks?: () => Promise<PurgeTerminalTasksResult | null>;
  purgingTerminalTasks?: boolean;
  passkeyConfigured?: boolean;
  removingPasskey?: boolean;
  onRemovePasskey?: () => Promise<boolean>;
}

export function DangerZoneSection({
  onResetAll,
  resetting = false,
  onKillServer,
  killingServer = false,
  onPurgeTerminalTasks,
  purgingTerminalTasks = false,
  passkeyConfigured = false,
  removingPasskey = false,
  onRemovePasskey,
}: DangerZoneSectionProps) {
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showResetTextConfirm, setShowResetTextConfirm] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState("");
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purgeResult, setPurgeResult] = useState<PurgeTerminalTasksResult | null>(null);
  const [purgeError, setPurgeError] = useState(false);
  const [serverKilled, setServerKilled] = useState(false);
  const [killError, setKillError] = useState(false);
  const [dangerZoneExpanded, setDangerZoneExpanded] = useState(false);
  const resetConfirmInputRef = useRef<HTMLInputElement>(null);

  const reloadPage = useCallback(() => {
    window.location.reload();
  }, []);

  const { countdown, progressPercent } = useCountdownReload(serverKilled, reloadPage);

  // Auto-focus the text confirmation input when it appears
  useEffect(() => {
    if (showResetTextConfirm) {
      resetConfirmInputRef.current?.focus();
    }
  }, [showResetTextConfirm]);

  if (!onResetAll && !onKillServer && !onPurgeTerminalTasks && !passkeyConfigured) return null;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
      <div className="p-4 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20">
        <button
          type="button"
          onClick={() => {
            setDangerZoneExpanded((v) => {
              if (v) {
                // Collapsing: reset all confirmation state
                setShowResetConfirm(false);
                setShowResetTextConfirm(false);
                setResetConfirmText("");
                setShowKillConfirm(false);
                setShowPurgeConfirm(false);
                setPurgeResult(null);
                setPurgeError(false);
                setKillError(false);
              }
              return !v;
            });
          }}
          className="w-full flex items-center gap-2 text-sm font-medium text-red-800 dark:text-red-200 hover:text-red-900 dark:hover:text-red-100 transition-colors text-left cursor-pointer"
          aria-expanded={dangerZoneExpanded}
        >
          <span className="text-xs">{dangerZoneExpanded ? "\u25BC" : "\u25B6"}</span>
          <span>Danger Zone</span>
        </button>

        {dangerZoneExpanded && (
          <div className="mt-4 space-y-4">
            {/* Kill Server */}
            {onKillServer && (
              <div>
                <p className="text-sm text-red-600 dark:text-red-400 mb-3">
                  Terminate the server process. In containerized environments (k8s), this will restart the container.
                </p>
                {serverKilled ? (
                  <div className="space-y-2">
                    <div className="text-sm text-red-600 dark:text-red-400 font-medium">
                      Server is shutting down... Reloading in {countdown}s
                    </div>
                    <div className="w-full h-1.5 bg-red-200 dark:bg-red-900 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-red-500 dark:bg-red-400 rounded-full transition-all duration-1000 ease-linear"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  </div>
                ) : !showKillConfirm ? (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setKillError(false);
                      setShowKillConfirm(true);
                    }}
                    disabled={resetting || killingServer}
                  >
                    Kill server
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-sm text-red-600 dark:text-red-400">Are you sure?</span>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={async () => {
                          if (onKillServer) {
                            setKillError(false);
                            const success = await onKillServer();
                            if (success) {
                              setServerKilled(true);
                              // Don't close the modal - let the user see the shutdown message
                            } else {
                              setKillError(true);
                            }
                          }
                        }}
                        loading={killingServer}
                      >
                        Yes, kill server
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowKillConfirm(false);
                          setKillError(false);
                        }}
                        disabled={killingServer}
                      >
                        Cancel
                      </Button>
                    </div>
                    {killError && (
                      <div className="text-sm text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/30 rounded px-2 py-1">
                        Failed to kill server. Please try again.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {onPurgeTerminalTasks && (
              <div className={onKillServer ? "pt-4 border-t border-red-200 dark:border-red-800" : ""}>
                <p className="text-sm text-red-600 dark:text-red-400 mb-3">
                  Permanently delete archived terminal tasks across every workspace. This applies to deleted tasks and to merged, pushed, or accepted-local tasks that are no longer awaiting feedback; addressable pushed and accepted-local tasks are kept.
                </p>
                {purgeResult && (
                  <div className={`mb-3 rounded px-2 py-1 text-sm ${
                    purgeResult.failures.length > 0
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                      : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                  }`}>
                    {purgeResult.totalArchived === 0
                      ? "No terminal-state tasks were found across all workspaces."
                      : purgeResult.failures.length > 0
                        ? `Purged ${purgeResult.purgedCount} of ${purgeResult.totalArchived} terminal-state tasks across ${purgeResult.totalWorkspaces} workspaces.`
                        : `Purged ${purgeResult.purgedCount} terminal-state tasks across ${purgeResult.totalWorkspaces} workspaces.`}
                    {purgeResult.failures.length > 0 && (
                      <div className="mt-1 text-xs">
                        Failed task IDs: {purgeResult.failures.map((failure) => failure.taskId).join(", ")}
                      </div>
                    )}
                  </div>
                )}
                {purgeError && (
                  <div className="mb-3 text-sm text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/30 rounded px-2 py-1">
                    Failed to purge terminal-state tasks. Please try again.
                  </div>
                )}
                {!showPurgeConfirm ? (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setPurgeResult(null);
                      setPurgeError(false);
                      setShowPurgeConfirm(true);
                    }}
                    disabled={resetting || killingServer || purgingTerminalTasks}
                  >
                    Purge terminal-state tasks
                  </Button>
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm text-red-600 dark:text-red-400">Are you sure?</span>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={async () => {
                        setPurgeError(false);
                        const result = await onPurgeTerminalTasks();
                        setShowPurgeConfirm(false);
                        if (result) {
                          setPurgeResult(result);
                        } else {
                          setPurgeError(true);
                        }
                      }}
                      loading={purgingTerminalTasks}
                    >
                      Yes, purge tasks
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setShowPurgeConfirm(false);
                        setPurgeError(false);
                      }}
                      disabled={purgingTerminalTasks}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Reset All Settings */}
            {onResetAll && (
              <div className={`space-y-3 ${onKillServer || onPurgeTerminalTasks ? "pt-4 border-t border-red-200 dark:border-red-800" : ""}`}>
                <p className="text-sm text-red-600 dark:text-red-400">
                  This will delete all tasks, sessions, workspaces, and preferences. This action cannot be undone.
                </p>
                {!showResetConfirm ? (
                  // Step 1: Initial button
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => setShowResetConfirm(true)}
                    disabled={resetting || killingServer}
                  >
                    Reset all settings
                  </Button>
                ) : !showResetTextConfirm ? (
                  // Step 2: "Are you sure?" confirmation
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm text-red-600 dark:text-red-400">Are you sure?</span>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => setShowResetTextConfirm(true)}
                      disabled={resetting || killingServer}
                    >
                      Yes, delete everything
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowResetConfirm(false)}
                      disabled={resetting || killingServer}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  // Step 3: Type confirmation phrase
                  <div className="space-y-3">
                    <p className="text-sm text-red-700 dark:text-red-300 font-medium">
                      This will permanently delete all tasks, sessions, workspaces, and preferences.
                      This action cannot be undone.
                    </p>
                    <p className="text-sm text-red-600 dark:text-red-400">
                      To confirm, type{" "}
                      <code className="break-all rounded bg-red-100 px-1.5 py-0.5 font-mono font-bold text-red-800 dark:bg-red-900/40 dark:text-red-200">
                        {RESET_CONFIRMATION_PHRASE}
                      </code>
                      {" "}below.
                    </p>
                    <input
                      ref={resetConfirmInputRef}
                      type="text"
                      value={resetConfirmText}
                      onChange={(e) => setResetConfirmText(e.target.value)}
                      placeholder="Type here to confirm"
                      className="block w-full rounded-md border-red-300 dark:border-red-700 bg-white dark:bg-neutral-800 text-sm text-gray-900 dark:text-gray-100 shadow-sm focus:border-red-500 focus:ring-red-500 px-3 py-2 disabled:opacity-50"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={resetting || killingServer}
                    />
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        disabled={resetConfirmText !== RESET_CONFIRMATION_PHRASE || resetting || killingServer}
                        onClick={async () => {
                          if (onResetAll) {
                            const success = await onResetAll();
                            if (success) {
                              setShowResetConfirm(false);
                              setShowResetTextConfirm(false);
                              setResetConfirmText("");
                              // Reload the page to get fresh state
                              window.location.reload();
                            }
                          }
                        }}
                        loading={resetting}
                      >
                        Confirm Reset
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowResetConfirm(false);
                          setShowResetTextConfirm(false);
                          setResetConfirmText("");
                        }}
                        disabled={resetting || killingServer}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {passkeyConfigured && (
              <div className={onKillServer || onPurgeTerminalTasks || onResetAll ? "pt-4 border-t border-red-200 dark:border-red-800" : ""}>
                <RemovePasskeySection
                  removingPasskey={removingPasskey}
                  onRemovePasskey={onRemovePasskey}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
