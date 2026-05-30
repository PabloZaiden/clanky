import type {
  DevboxPublishedPort,
  DevboxStatusResult,
  ProvisioningJobError,
  ProvisioningStep,
} from "../../types";

export function parseDevboxStatusOutput(output: string): DevboxStatusResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("devbox status did not return valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("devbox status did not return an object");
  }

  const record = parsed as Record<string, unknown>;
  const publishedPorts = record["publishedPorts"];
  const normalizedPublishedPorts = (
    publishedPorts && typeof publishedPorts === "object" && !Array.isArray(publishedPorts)
      ? Object.fromEntries(
          Object.entries(publishedPorts).map(([key, value]) => {
            const entries = Array.isArray(value)
              ? value.flatMap((item) => {
                  if (!item || typeof item !== "object" || Array.isArray(item)) {
                    return [];
                  }

                  const candidate = item as Record<string, unknown>;
                  if (typeof candidate["hostPort"] !== "number") {
                    return [];
                  }

                  return [{
                    hostIp: typeof candidate["hostIp"] === "string" ? candidate["hostIp"] : "",
                    hostPort: candidate["hostPort"],
                  } satisfies DevboxPublishedPort];
                })
              : [];
            return [key, entries];
          }),
        )
      : undefined
  );

  return {
    running: record["running"] === true,
    port: typeof record["port"] === "number" ? record["port"] : null,
    password: typeof record["password"] === "string" ? record["password"] : null,
    workdir: typeof record["workdir"] === "string" ? record["workdir"] : null,
    sshUser: typeof record["sshUser"] === "string" ? record["sshUser"] : null,
    sshPort: typeof record["sshPort"] === "number" ? record["sshPort"] : null,
    remoteUser: typeof record["remoteUser"] === "string" ? record["remoteUser"] : null,
    hasCredentialFile: record["hasCredentialFile"] === true,
    credentialPath: typeof record["credentialPath"] === "string" ? record["credentialPath"] : null,
    publishedPorts: normalizedPublishedPorts,
  };
}

export function parseDevboxCredentialContent(content: string): {
  username?: string;
  password?: string;
} {
  const trimmed = content.trim();
  if (!trimmed) {
    return {};
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return {
        username:
          typeof parsed["username"] === "string"
            ? parsed["username"]
            : typeof parsed["user"] === "string"
              ? parsed["user"]
              : typeof parsed["sshUser"] === "string"
                ? parsed["sshUser"]
                : undefined,
        password:
          typeof parsed["password"] === "string"
            ? parsed["password"]
            : typeof parsed["pass"] === "string"
              ? parsed["pass"]
              : undefined,
      };
    } catch {
      // Fall through to line-based parsing.
    }
  }

  const result: { username?: string; password?: string } = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      if (!result.password && line.trim()) {
        result.password = line.trim();
      }
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const rawValue = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!rawValue) {
      continue;
    }

    if (!result.username && (key === "username" || key === "user" || key === "ssh_user")) {
      result.username = rawValue;
      continue;
    }
    if (!result.password && (key === "password" || key === "pass" || key === "ssh_password")) {
      result.password = rawValue;
    }
  }

  return result;
}

export function getPublishedPortFallback(status: DevboxStatusResult): number | undefined {
  if (!status.publishedPorts) {
    return undefined;
  }

  for (const entries of Object.values(status.publishedPorts)) {
    const firstEntry = entries.find((entry) => typeof entry.hostPort === "number");
    if (firstEntry) {
      return firstEntry.hostPort;
    }
  }

  return undefined;
}

export function buildError(code: string, step: ProvisioningStep, message: string): ProvisioningJobError {
  return { code, step, message };
}
