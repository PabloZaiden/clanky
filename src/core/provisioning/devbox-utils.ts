import { z } from "zod";
import type { DevboxPublishedPort, DevboxStatusResult, ProvisioningJobError, ProvisioningStep } from "@/shared";

const DevboxPublishedPortSchema = z.object({
  hostIp: z.string().nullable(),
  hostPort: z.number().int().min(1).max(65535).nullable(),
});

const DevboxStatusSchema = z.object({
  running: z.boolean(),
  ports: z.array(z.number().int().min(1).max(65535)),
  sshEnabled: z.boolean(),
  password: z.string().nullable(),
  workdir: z.string(),
  sshUser: z.string().nullable(),
  sshPort: z.number().int().min(1).max(65535).nullable(),
  remoteUser: z.string().nullable(),
  hasCredentialFile: z.boolean(),
  credentialPath: z.string(),
  publishedPorts: z.record(z.string(), z.array(DevboxPublishedPortSchema)),
});

export function parseDevboxStatusOutput(output: string): DevboxStatusResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("Failed to parse devbox status output as JSON", { cause: error });
  }

  const result = DevboxStatusSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Failed to validate devbox status output: ${result.error.issues[0]?.message ?? "invalid format"}`);
  }

  return result.data;
}

export function parseDevboxCredentialContent(content: string): {
  password?: string;
} {
  const trimmed = content.trim();
  return trimmed ? { password: trimmed } : {};
}

export function getPublishedPortFallback(status: DevboxStatusResult): number | undefined {
  for (const entries of Object.values(status.publishedPorts)) {
    const firstEntry = entries.find((entry): entry is DevboxPublishedPort & { hostPort: number } =>
      typeof entry.hostPort === "number");
    if (firstEntry?.hostPort !== undefined) {
      return firstEntry.hostPort;
    }
  }

  return undefined;
}

export interface DevboxPublishedPortMapping {
  containerPort: number;
  hostPort: number;
}

export function getSinglePublishedPort(
  status: DevboxStatusResult,
): DevboxPublishedPortMapping {
  const mappings = new Map<number, Set<number>>();
  for (const [containerPortKey, entries] of Object.entries(status.publishedPorts)) {
    const match = containerPortKey.match(/^(\d+)\/(?:tcp|udp)$/i);
    const containerPort = match ? Number(match[1]) : undefined;
    if (!containerPort || containerPort < 1 || containerPort > 65535) {
      continue;
    }
    for (const entry of entries) {
      if (
        typeof entry.hostPort !== "number"
        || !Number.isInteger(entry.hostPort)
        || entry.hostPort < 1
        || entry.hostPort > 65535
      ) {
        continue;
      }
      const hostPorts = mappings.get(containerPort) ?? new Set<number>();
      hostPorts.add(entry.hostPort);
      mappings.set(containerPort, hostPorts);
    }
  }

  if (mappings.size !== 1) {
    throw new Error("Devbox must publish exactly one port for worker provisioning.");
  }

  const [containerPort, hostPorts] = [...mappings.entries()][0]!;
  if (hostPorts.size !== 1) {
    throw new Error("Devbox must publish exactly one host port for worker provisioning.");
  }

  return {
    containerPort,
    hostPort: [...hostPorts][0]!,
  };
}

export function buildError(code: string, step: ProvisioningStep, message: string): ProvisioningJobError {
  return { code, step, message };
}
