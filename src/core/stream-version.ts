import type { StreamDeltaPosition, StreamPosition } from "@/shared/stream-position";

export class StreamVersion {
  private readonly epoch = crypto.randomUUID();
  private revision = 0;
  private previousRevision = 0;

  get position(): StreamPosition {
    return { epoch: this.epoch, revision: this.revision };
  }

  get change(): StreamDeltaPosition {
    return { ...this.position, baseRevision: this.previousRevision };
  }

  advance(): void {
    this.previousRevision = this.revision;
    this.revision += 1;
  }
}
