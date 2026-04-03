import type { SshServer, UpdateSshServerRequest } from "../../types";

export interface SshServerFormValues {
  name: string;
  address: string;
  username: string;
  repositoriesBasePath: string;
  password: string;
}

export interface TrimmedSshServerFormValues {
  name: string;
  address: string;
  username: string;
  repositoriesBasePath?: string;
  password?: string;
}

export function createSshServerFormValues(server?: SshServer | null): SshServerFormValues {
  return {
    name: server?.config.name ?? "",
    address: server?.config.address ?? "",
    username: server?.config.username ?? "",
    repositoriesBasePath: server?.config.repositoriesBasePath ?? "",
    password: "",
  };
}

export function trimSshServerFormValues(values: SshServerFormValues): TrimmedSshServerFormValues {
  return {
    name: values.name.trim(),
    address: values.address.trim(),
    username: values.username.trim(),
    repositoriesBasePath: values.repositoriesBasePath.trim() || undefined,
    password: values.password.trim() || undefined,
  };
}

export function buildSshServerUpdateRequest(
  server: SshServer,
  values: TrimmedSshServerFormValues,
): UpdateSshServerRequest | undefined {
  const patch = {
    ...(values.name !== server.config.name ? { name: values.name } : {}),
    ...(values.address !== server.config.address ? { address: values.address } : {}),
    ...(values.username !== server.config.username ? { username: values.username } : {}),
    ...(values.repositoriesBasePath !== server.config.repositoriesBasePath
      ? { repositoriesBasePath: values.repositoriesBasePath ?? null }
      : {}),
  };

  return Object.keys(patch).length > 0 ? patch : undefined;
}

