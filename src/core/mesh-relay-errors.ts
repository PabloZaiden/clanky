/**
 * Transport-level failures raised by the Mesh relay connector.
 *
 * These are intentionally *not* `DomainError`s: Mesh callers already wrap
 * unrecognised transport failures into their own `mesh_*_unreachable` domain
 * codes, and raising a `DomainError` here would bypass that mapping and
 * surface a relay implementation detail to the API boundary.
 */

export class MeshRelayStreamError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MeshRelayStreamError";
    this.code = code;
    this.status = options.status ?? 502;
  }
}

/** True when the relay reported that the peer is simply not connected. */
export function isMeshRelayUnreachable(error: unknown): boolean {
  return error instanceof MeshRelayStreamError && error.status === 503;
}
