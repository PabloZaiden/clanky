import { useMemo, useState } from "react";
import { StatusBadge } from "../common";
import { getEffectiveTerminalConnectionMode, getTerminalConnectionModeLabel, isPersistentTerminalSession } from "../../utils";
import { CompactBar } from "../terminal/compact-bar";
import type { SshServerSession } from "@/shared";

export interface SshServerSessionInfoSectionProps {
  session: SshServerSession;
  standaloneServerName: string | null;
  standaloneServerTarget: string | null;
}

export function SshServerSessionInfoSection({
  session,
  standaloneServerName,
  standaloneServerTarget,
}: SshServerSessionInfoSectionProps) {
  const [expanded, setExpanded] = useState(false);

  const effectiveConnectionMode = useMemo(() => getEffectiveTerminalConnectionMode(session), [session]);
  const hasPersistentSession = useMemo(() => isPersistentTerminalSession(session), [session]);

  const summary = useMemo(() => (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs text-gray-500 dark:text-gray-400">
      <StatusBadge variant={effectiveConnectionMode === "direct" ? "info" : "default"} className="shrink-0">
        {getTerminalConnectionModeLabel(effectiveConnectionMode)}
      </StatusBadge>

      {session.state.notice && (
        <StatusBadge variant="warning" className="shrink-0">
          fallback
        </StatusBadge>
      )}
      {session.state.error && (
        <StatusBadge variant="error" className="shrink-0">
          error
        </StatusBadge>
      )}
    </div>
  ), [effectiveConnectionMode, session]);

  return (
    <CompactBar
      title="Session Info"
      expanded={expanded}
      onToggle={() => setExpanded((current) => !current)}
      summary={summary}
    >
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-gray-500 dark:text-gray-400">Mode</dt>
          <dd className="text-gray-900 dark:text-gray-100">
            {getTerminalConnectionModeLabel(effectiveConnectionMode)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-gray-500 dark:text-gray-400">
            Server
          </dt>
          <dd className="break-words text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
            {standaloneServerName}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-gray-500 dark:text-gray-400">
            Address
          </dt>
          <dd className="break-words font-mono text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
            {standaloneServerTarget}
          </dd>
        </div>
        {hasPersistentSession ? (
          <div className="min-w-0">
            <dt className="text-gray-500 dark:text-gray-400">Persistent session ID</dt>
            <dd className="break-words font-mono text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">{session.config.remoteSessionName}</dd>
          </div>
        ) : (
          <div className="min-w-0">
            <dt className="text-gray-500 dark:text-gray-400">Reconnect behavior</dt>
            <dd className="text-gray-900 dark:text-gray-100">Opens a fresh shell each time</dd>
          </div>
        )}
        <div className="min-w-0">
          <dt className="text-gray-500 dark:text-gray-400">Last connected</dt>
          <dd className="text-gray-900 dark:text-gray-100">{session.state.lastConnectedAt ?? "Never"}</dd>
        </div>
        {session.state.notice && (
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-gray-500 dark:text-gray-400">Notice</dt>
            <dd className="break-words text-amber-700 dark:text-amber-300">{session.state.notice}</dd>
          </div>
        )}
        {session.state.error && (
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-gray-500 dark:text-gray-400">Last error</dt>
            <dd className="break-words text-red-600 dark:text-red-400">{session.state.error}</dd>
          </div>
        )}
      </dl>
    </CompactBar>
  );
}
