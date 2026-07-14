import type { SshServer, SshServerSession } from "@/shared";
import { Badge } from "../common";
import { DataList, DataListRow, EmptyState, Panel, type WebAppRoute } from "@pablozaiden/webapp/web";
import { getPrivateContainerClassName, isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";

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
      <Panel
        actions={(
          <Badge variant="default" size="sm">
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </Badge>
        )}
      >
        <DataList>
          <div className={getPrivateContainerClassName(serverPrivateHidden)}>
            <DataListRow
              title="Address"
              description="Stored without credentials on the server."
              meta={server.config.address}
            />
          </div>
          <div className={getPrivateContainerClassName(serverPrivateHidden)}>
            <DataListRow
              title="Username"
              description="Used for standalone SSH sessions."
              meta={server.config.username}
            />
          </div>
          <DataListRow
            title="Saved sessions"
            description="Standalone terminals attached to this host."
            meta={String(sessions.length)}
          />
          {server.config.repositoriesBasePath ? (
            <div className={getPrivateContainerClassName(serverPrivateHidden)}>
              <DataListRow
                title="Repositories base path"
                description="Default base path for automatic provisioning."
                meta={server.config.repositoriesBasePath}
              />
            </div>
          ) : null}
        </DataList>
      </Panel>

      <Panel title="Standalone sessions">
        <DataList>
          {sessions.length === 0 ? (
            <EmptyState
              title="No standalone sessions yet"
              description="Create one to connect to this SSH server."
            />
          ) : (
            sessions.map((session) => {
              const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(session.config, [server.config]), showPrivateItems);
              return (
                <div
                  key={session.config.id}
                  className={getPrivateContainerClassName(privateHidden)}
                >
                  <DataListRow
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
                    onClick={privateHidden ? undefined : () => onNavigate({ view: "ssh", sshSessionId: session.config.id })}
                  />
                </div>
              );
            })
          )}
        </DataList>
      </Panel>
    </div>
  );
}
