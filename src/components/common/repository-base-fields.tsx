import { useId } from "react";
import { Button, SelectField, useLiveQuery } from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared";
import type { RepositoryBaseSelection, WorkspaceRepository } from "@/shared/repository-group";
import { apiRequest } from "../../lib/api-client";

export function useWorkspaceRepositories(workspace?: Pick<Workspace, "id" | "directory" | "workspaceType"> | null, enabled = true) {
  const id = workspace?.id;
  return useLiveQuery<WorkspaceRepository[]>({
    enabled: enabled && workspace?.workspaceType === "multi-git",
    deps: [id, workspace?.directory],
    load: (signal) => apiRequest(`/api/git/repositories?${new URLSearchParams({ workspaceId: id ?? "" })}`, {
      signal,
      action: "Discover workspace repositories",
    }),
  });
}

function branchLabel(ref: string) {
  return ref.replace(/^refs\/(?:heads|remotes)\//, "");
}

export function RepositoryBaseFields({ workspace, value, onChange, preferences = false }: {
  workspace: Workspace;
  value: RepositoryBaseSelection[];
  onChange: (value: RepositoryBaseSelection[]) => void;
  preferences?: boolean;
}) {
  const id = useId();
  const query = useWorkspaceRepositories(workspace);
  const repositories = query.data ?? [];
  return (
    <div className="space-y-3">
      {query.error ? <p role="alert">Could not discover repositories: {String(query.error)}</p> : null}
      {!query.error && query.loading && !query.data ? <p role="status">Finding repositories…</p> : null}
      {query.data?.length === 0 ? <p>No Git repositories found.</p> : null}
      {repositories.map((repository, index) => {
        const selected = value.find((base) => base.repository === repository.name && (!base.identity || base.identity === repository.identity));
        const inherited = preferences
          ? undefined
          : workspace.repositoryBases?.find((base) => base.repository === repository.name && base.identity === repository.identity);
        const inheritedRef = inherited?.ref ?? repository.defaultRef;
        const ref = selected?.ref ?? "";
        return (
          <SelectField key={repository.name} id={`${id}-${index}`} label={repository.name} value={ref}
            onChange={(event) => {
              const next = event.currentTarget.value;
              const other = value.filter((base) => base.repository !== repository.name);
              onChange(next ? [...other, { repository: repository.name, identity: repository.identity, ref: next }] : other);
            }}>
            <option value="">{inheritedRef ? `Inherit (${branchLabel(inheritedRef)})` : "Inherit (no default branch found)"}</option>
            {ref && !repository.refs.includes(ref) ? <option value={ref}>{branchLabel(ref)} (unavailable)</option> : null}
            {repository.refs.map((branch) => (
              <option key={branch} value={branch}>
                {branchLabel(branch)} ({branch.startsWith("refs/heads/") ? "local" : "remote"})
              </option>
            ))}
          </SelectField>
        );
      })}
      {query.data && value.some((base) => !repositories.some((repo) => repo.name === base.repository && (!base.identity || repo.identity === base.identity)))
        ? <Button type="button" onClick={() => onChange(value.filter((base) => repositories.some((repo) =>
          repo.name === base.repository && (!base.identity || repo.identity === base.identity))))}>Remove unavailable selections</Button>
        : null}
      <Button type="button" onClick={() => void query.refresh()} loading={query.loading}>Refresh repositories</Button>
    </div>
  );
}
