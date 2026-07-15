import type { SshServer, SshServerSession } from "@/shared";
import { Badge } from "../common";
import { EmptyState, type WebAppRoute } from "@pablozaiden/webapp/web";
import { getPrivateContainerClassName, isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";
import { ClankyListRow } from "./clanky-list-row";

function SummaryCard({
  label,
  value,
  meta,
  className = "",
}: {
  label: string;
  value: string | number;
  meta: string;
  className?: string;
}) {
  return (
    <div className={`min-w-0 rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-neutral-950/50 ${className}`}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-2 overflow-hidden break-words text-2xl font-semibold text-gray-950 [overflow-wrap:anywhere] sm:text-3xl dark:text-gray-100">{value}</p>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{meta}</p>
    </div>
  );
}

export function SshServerView({
  server,
  sessions,
  onNavigate,
  showPrivateItems = false,
}: {
  server: SshServer;
  sessions: SshServerSession[];
  onNavigate: (route: WebAppRoute) => void;
  showPrivateItems?: boolean;
}) {
  const serverPrivateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(server.config), showPrivateItems);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-3">
        <SummaryCard label="Address" value={server.config.address} meta="Stored without credentials on the server." className={getPrivateContainerClassName(serverPrivateHidden)} />
        <SummaryCard label="Username" value={server.config.username} meta="Used for standalone SSH sessions." className={getPrivateContainerClassName(serverPrivateHidden)} />
        <SummaryCard label="Saved sessions" value={sessions.length} meta="Standalone terminals attached to this host." className={getPrivateContainerClassName(serverPrivateHidden)} />
        {server.config.repositoriesBasePath ? (
          <SummaryCard label="Repositories base path" value={server.config.repositoriesBasePath} meta="Default base path for automatic provisioning." className={getPrivateContainerClassName(serverPrivateHidden)} />
        ) : null}
      </div>

      <section className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
        <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Standalone sessions</h2>
        <div>
          {sessions.length === 0 ? (
            <EmptyState title="No standalone sessions yet" description="Create one to connect to this SSH server." />
          ) : (
            <div className="space-y-2">{sessions.map((session) => {
              const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(session.config, [server.config]), showPrivateItems);
              return (
                <ClankyListRow
                  key={session.config.id}
                  title={session.config.name}
                  description={session.config.connectionMode === "direct" ? "Direct SSH" : "Persistent SSH"}
                  badge={(
                    <Badge
                      variant={
                        session.state.status === "connected"
                          ? "success"
                          : session.state.status === "failed"
                            ? "error"
                            : "default"
                      }
                    >
                      {session.state.status}
                    </Badge>
                  )}
                  onClick={!privateHidden ? () => onNavigate({ view: "ssh", sshSessionId: session.config.id }) : undefined}
                  privateHidden={privateHidden}
                />
              );
            })}</div>
          )}
        </div>
      </section>
    </div>
  );
}
