import { z } from "zod";
import type { EnvironmentPublishedPort, EnvironmentStatusResult, ProvisioningJobError, ProvisioningStep } from "@/shared";

const EnvironmentPublishedPortSchema = z.object({
  hostIp: z.string().nullable(),
  hostPort: z.number().int().min(1).max(65535).nullable(),
});

const EnvironmentStatusSchema = z.object({
  running: z.boolean(),
  ports: z.array(z.number().int().min(1).max(65535)),
  workdir: z.string(),
  publishedPorts: z.record(z.string(), z.array(EnvironmentPublishedPortSchema)),
  hostRuntimeDirectory: z.string().min(1),
  runtimeDirectory: z.string().min(1),
});

export function parseEnvironmentStatusOutput(output: string): EnvironmentStatusResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("Failed to parse environment status output as JSON", { cause: error });
  }

  const result = EnvironmentStatusSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Failed to validate environment status output: ${result.error.issues[0]?.message ?? "invalid format"}`);
  }

  return result.data;
}

export function getPublishedPortFallback(status: EnvironmentStatusResult): number | undefined {
  for (const entries of Object.values(status.publishedPorts)) {
    const firstEntry = entries.find((entry): entry is EnvironmentPublishedPort & { hostPort: number } =>
      typeof entry.hostPort === "number");
    if (firstEntry?.hostPort !== undefined) {
      return firstEntry.hostPort;
    }
  }

  return undefined;
}

export interface EnvironmentPublishedPortMapping {
  containerPort: number;
  hostPort: number;
}

export function getSinglePublishedPort(
  status: EnvironmentStatusResult,
): EnvironmentPublishedPortMapping {
  const mappings = new Map<number, Set<number>>();
  for (const [containerPortKey, entries] of Object.entries(status.publishedPorts)) {
    const match = containerPortKey.match(/^(\d+)\/tcp$/i);
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
    throw new Error("Environment must publish exactly one port for worker provisioning.");
  }

  const [containerPort, hostPorts] = [...mappings.entries()][0]!;
  if (hostPorts.size !== 1) {
    throw new Error("Environment must publish exactly one host port for worker provisioning.");
  }

  return {
    containerPort,
    hostPort: [...hostPorts][0]!,
  };
}

export function buildError(code: string, step: ProvisioningStep, message: string): ProvisioningJobError {
  return { code, step, message };
}
