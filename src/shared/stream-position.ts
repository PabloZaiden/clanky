export interface StreamPosition {
  epoch: string;
  revision: number;
}

export interface StreamDeltaPosition extends StreamPosition {
  baseRevision: number;
}
