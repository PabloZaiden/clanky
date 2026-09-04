/**
 * Coordinates deterministic shutdown of inbound Mesh resources when the
 * local node's execution policy or capabilities change.
 */

import type {
  ExecutionHostCapabilityId,
  ExecutionNodeConfiguration,
} from "@/shared";

interface MeshInboundResourceOwner {
  id: string;
  capabilities: readonly ExecutionHostCapabilityId[];
  close(reason: string): void | Promise<void>;
}

export class MeshInboundResourceRegistry {
  private readonly owners = new Map<string, MeshInboundResourceOwner>();

  register(owner: MeshInboundResourceOwner): () => void {
    if (this.owners.has(owner.id)) {
      throw new Error(`Mesh inbound resource owner is already registered: ${owner.id}`);
    }
    this.owners.set(owner.id, owner);
    return () => {
      if (this.owners.get(owner.id) === owner) {
        this.owners.delete(owner.id);
      }
    };
  }

  async applyPolicy(
    previous: ExecutionNodeConfiguration,
    next: ExecutionNodeConfiguration,
  ): Promise<void> {
    const disabledCapabilities = new Set<ExecutionHostCapabilityId>();
    for (const capability of Object.keys(previous.capabilities) as ExecutionHostCapabilityId[]) {
      if (
        (next.capabilities[capability] ?? 0)
        < (previous.capabilities[capability] ?? 0)
      ) {
        disabledCapabilities.add(capability);
      }
    }
    if (
      previous.acceptRemoteExecution === next.acceptRemoteExecution
      && disabledCapabilities.size === 0
    ) {
      return;
    }
    const owners = [...this.owners.values()].filter((owner) =>
      !next.acceptRemoteExecution
      || owner.capabilities.some((capability) => disabledCapabilities.has(capability))
    );
    await Promise.all(owners.map(async (owner) => {
      await owner.close("Mesh execution policy changed");
    }));
  }
}

export const meshInboundResourceRegistry = new MeshInboundResourceRegistry();
