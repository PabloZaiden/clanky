import { useCallback, useState } from "react";
import type { CreatedUserResponse, WebAppConfigResponse, WebAppUserRole, WebAppUserSummary } from "../../contracts";
import { appJson } from "../api-client";
import { useAsyncOperation } from "@pablozaiden/webapp/web";
import { Badge, Button, CodeValue, ConfirmDialog, EmptyState, FormGroup, FormSection, SelectField, TextField } from "@pablozaiden/webapp/web";
import { DateTimeValue } from "@pablozaiden/webapp/web";
import { useLiveQuery } from "@pablozaiden/webapp/web";
import { ResourceState } from "./resource-state";

export function UserManagement({ config }: { config: WebAppConfigResponse }) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<WebAppUserRole>("user");
  const [setupLink, setSetupLink] = useState<string>();
  const [userToDelete, setUserToDelete] = useState<WebAppUserSummary>();
  const [userToReset, setUserToReset] = useState<WebAppUserSummary>();
  const [error, setError] = useState<string>();
  const {
    pending: setupLinkPending,
    start: startSetupLinkMutation,
    isCurrent: isSetupLinkMutationCurrent,
    finish: finishSetupLinkMutation,
  } = useAsyncOperation({ abortOnUnmount: false });

  const loadUsers = useCallback(
    () => config.userManagement.canManageUsers
      ? appJson<WebAppUserSummary[]>("/api/users")
      : Promise.resolve([]),
    [config.userManagement.canManageUsers],
  );
  const { data: users, error: usersLoadError, loading: usersLoading, refresh: refreshUsers } = useLiveQuery<WebAppUserSummary[]>({ load: loadUsers, realtime: false });

  async function createUser() {
    const operationToken = startSetupLinkMutation();
    if (!operationToken) {
      return;
    }
    setError(undefined);
    try {
      const result = await appJson<CreatedUserResponse>("/api/users", {
        method: "POST",
        body: JSON.stringify({ username, role }),
        signal: operationToken.signal,
      });
      if (!isSetupLinkMutationCurrent(operationToken)) {
        return;
      }
      setUsername("");
      setRole("user");
      setSetupLink(result.setupLink.url);
      await refreshUsers();
    } catch (err) {
      if (isSetupLinkMutationCurrent(operationToken)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      finishSetupLinkMutation(operationToken);
    }
  }

  async function updateRole(user: WebAppUserSummary, nextRole: WebAppUserRole) {
    try {
      setError(undefined);
      await appJson(`/api/users/${encodeURIComponent(user.id)}/role`, { method: "PATCH", body: JSON.stringify({ role: nextRole }) });
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resetUser(user: WebAppUserSummary) {
    const operationToken = startSetupLinkMutation();
    if (!operationToken) {
      return;
    }
    setError(undefined);
    try {
      const result = await appJson<CreatedUserResponse>(`/api/users/${encodeURIComponent(user.id)}/reset`, {
        method: "POST",
        body: "{}",
        signal: operationToken.signal,
      });
      if (!isSetupLinkMutationCurrent(operationToken)) {
        return;
      }
      setSetupLink(result.setupLink.url);
      setUserToReset(undefined);
      await refreshUsers();
    } catch (err) {
      if (isSetupLinkMutationCurrent(operationToken)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      finishSetupLinkMutation(operationToken);
    }
  }

  async function deleteUser(user: WebAppUserSummary) {
    try {
      setError(undefined);
      await appJson(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      setUserToDelete(undefined);
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!config.userManagement.canManageUsers) {
    return null;
  }
  return (
    <FormSection title="Users">
      {error ? <p className="wapp-error">{error}</p> : null}
      <FormGroup title="Add user" layout="inline">
          <TextField label="Username" fieldWidth="short" value={username} disabled={setupLinkPending} onChange={(event) => setUsername(event.currentTarget.value)} placeholder="new-user" />
          <SelectField label="Role" value={role} disabled={setupLinkPending} onChange={(event) => setRole(event.currentTarget.value as WebAppUserRole)}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </SelectField>
        <div className="wapp-row-actions"><Button type="button" variant="primary" loading={setupLinkPending} disabled={!username.trim()} onClick={() => void createUser()}>Create setup link</Button></div>
        {setupLink ? <CodeValue label="Setup link" value={setupLink} /> : null}
      </FormGroup>
      <ResourceState loading={usersLoading} error={usersLoadError} hasData={users !== undefined} refresh={refreshUsers} />
      {users?.length ? (
        <div className="wapp-list">
          {users.map((user) => (
            <div className="wapp-list-row" key={user.id}>
              <span>
                <strong>{user.username}</strong>
                <small>{user.passkeyConfigured ? "Passkey configured" : "Setup pending"} · <DateTimeValue value={user.createdAt} /></small>
              </span>
              <div className="wapp-row-actions">
                {user.role !== "owner" ? (
                  <select className="wapp-inline-select" aria-label={`Role for ${user.username}`} value={user.role} onChange={(event) => void updateRole(user, event.currentTarget.value as WebAppUserRole)}>
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : <Badge variant="success">Owner</Badge>}
                {user.role !== "owner" ? <>
                  <Button disabled={setupLinkPending} onClick={() => setUserToReset(user)}>Reset account access</Button>
                  <Button disabled={setupLinkPending} tone="danger" onClick={() => setUserToDelete(user)}>Delete user</Button>
                </> : null}
              </div>
            </div>
          ))}
        </div>
      ) : users !== undefined && !usersLoadError ? <EmptyState title="No users" /> : null}
      <ConfirmDialog
        open={Boolean(userToReset)}
        title="Reset account access?"
        message={userToReset ? `This removes "${userToReset.username}"'s passkey and API keys, revokes device sessions and signs them out. A new setup link will be created.` : ""}
        confirmLabel="Reset account access"
        danger
        loading={setupLinkPending}
        onCancel={() => setUserToReset(undefined)}
        onConfirm={() => userToReset && void resetUser(userToReset)}
      />
      <ConfirmDialog
        open={Boolean(userToDelete)}
        title="Delete user?"
        message={userToDelete ? `This permanently deletes "${userToDelete.username}" and revokes their setup links, API keys, passkeys and device sessions.` : ""}
        confirmLabel="Delete user"
        danger
        onCancel={() => setUserToDelete(undefined)}
        onConfirm={() => userToDelete && void deleteUser(userToDelete)}
      />
    </FormSection>
  );
}
