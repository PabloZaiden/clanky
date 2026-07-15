import type { SshServer, SshServerSession } from "@/shared";
import { Badge } from "../common";
import { EmptyState, type WebAppRoute } from "@pablozaiden/webapp/web";
import { getPrivateContainerClassName, isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";
import { ClankyListRow } from "./clanky-list-row";

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
        <div className={`rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-neutral-950 ${getPrivateContainerClassName(serverPrivateHidden)}`}>
          <div className="text-xs font-medium uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">Address</div>
          <div className="mt-2 break-all font-mono text-sm text-gray-900 dark:text-gray-100">{server.config.address}</div>
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">Stored without credentials on the server.</div>
        </div>
        <div className={`rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-neutral-950 ${getPrivateContainerClassName(serverPrivateHidden)}`}>
          <div className="text-xs font-medium uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">Username</div>
          <div className="mt-2 break-all font-mono text-sm text-gray-900 dark:text-gray-100">{server.config.username}</div>
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">Used for standalone SSH sessions.</div>
        </div>
        <div className={`rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-neutral-950 ${getPrivateContainerClassName(serverPrivateHidden)}`}>
          <div className="text-xs font-medium uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">Saved sessions</div>
          <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-gray-100">{sessions.length}</div>
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">Standalone terminals attached to this host.</div>
        </div>
        {server.config.repositoriesBasePath ? (
          <div className={`rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-neutral-950 ${getPrivateContainerClassName(serverPrivateHidden)}`}>
            <div className="text-xs font-medium uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">Repositories base path</div>
            <div className="mt-2 break-all font-mono text-sm text-gray-900 dark:text-gray-100">{server.config.repositoriesBasePath}</div>
            <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">Default base path for automatic provisioning.</div>
          </div>
        ) : null}
      </div>

      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-neutral-900">
        <h2 className="text-base font-semibold text-gray-950 dark:text-gray-100">Standalone sessions</h2>
        <div className="mt-4">
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
