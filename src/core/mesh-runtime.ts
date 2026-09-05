import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DomainError } from "./domain-error";

export type MeshRuntimeRole = "controller" | "worker";

interface MeshRuntimeConfiguration {
  role: MeshRuntimeRole;
  workerDirectory: string | null;
  workerExecutionEnabled: boolean;
}

let configuration: MeshRuntimeConfiguration = {
  role: "controller",
  workerDirectory: null,
  workerExecutionEnabled: false,
};

export async function configureMeshRuntime(options: {
  meshWorker: boolean;
  workerDirectory?: string;
  workerExecutionEnabled?: boolean;
}): Promise<void> {
  if (!options.meshWorker) {
    configuration = {
      role: "controller",
      workerDirectory: null,
      workerExecutionEnabled: false,
    };
    return;
  }
  const directory = resolve(options.workerDirectory?.trim() || process.cwd());
  let directoryStat;
  try {
    directoryStat = await stat(directory);
  } catch (error) {
    throw new DomainError(
      "mesh_worker_directory_invalid",
      `The Mesh worker directory does not exist: ${directory}`,
      { cause: error },
    );
  }
  if (!directoryStat.isDirectory()) {
    throw new DomainError(
      "mesh_worker_directory_invalid",
      `The Mesh worker directory is not a directory: ${directory}`,
    );
  }
  configuration = {
    role: "worker",
    workerDirectory: directory,
    workerExecutionEnabled: options.workerExecutionEnabled ?? true,
  };
}

export function requireMeshRuntimeRole(role: MeshRuntimeRole): void {
  if (configuration.role !== role) {
    throw new DomainError(
      "mesh_role_invalid",
      role === "worker"
        ? "This operation is only available on a Mesh worker."
        : "This operation is only available on a Mesh controller.",
    );
  }
}

export function getMeshRuntimeRole(): MeshRuntimeRole {
  return configuration.role;
}

export function getMeshWorkerDirectory(): string {
  requireMeshRuntimeRole("worker");
  return configuration.workerDirectory!;
}

export function isMeshWorkerExecutionEnabled(): boolean {
  requireMeshRuntimeRole("worker");
  return configuration.workerExecutionEnabled;
}
