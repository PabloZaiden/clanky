import type { Chat, Loop, SshServer, Workspace } from "@ralpher/shared";

export type EntityKind = "servers" | "workspaces" | "loops" | "chats";

interface EntityCollections {
  servers: SshServer[];
  workspaces: Workspace[];
  loops: Loop[];
  chats: Chat[];
}

type EntityItem<K extends EntityKind> = EntityCollections[K][number];

export class EntityCache {
  private readonly collections: EntityCollections = {
    servers: [],
    workspaces: [],
    loops: [],
    chats: [],
  };

  setCollection<K extends EntityKind>(kind: K, entities: EntityCollections[K]): void {
    this.collections[kind] = entities;
  }

  getCollection<K extends EntityKind>(kind: K): EntityCollections[K] {
    return this.collections[kind];
  }

  upsert<K extends EntityKind>(kind: K, entity: EntityItem<K>): void {
    const entities = this.collections[kind];
    const entityId = this.getEntityId(kind, entity);
    const nextEntities = entities.filter((candidate) => this.getEntityId(kind, candidate) !== entityId);
    nextEntities.push(entity);
    this.collections[kind] = nextEntities as EntityCollections[K];
  }

  remove<K extends EntityKind>(kind: K, id: string): void {
    this.collections[kind] = this.collections[kind].filter((entity) => {
      return this.getEntityId(kind, entity) !== id;
    }) as EntityCollections[K];
  }

  private getEntityId<K extends EntityKind>(kind: K, entity: EntityItem<K>): string {
    if (kind === "servers") {
      return (entity as SshServer).config.id;
    }
    if (kind === "workspaces") {
      return (entity as Workspace).id;
    }
    if (kind === "loops") {
      return (entity as Loop).config.id;
    }
    return (entity as Chat).config.id;
  }
}
