/**
 * Shared authorization and error handling for app-owned raw WebSocket routes.
 */

export type RawWebSocketUpgrade = () => Response | undefined | Promise<Response | undefined>;

export async function authorizedRawWebSocketUpgrade(
  _userId: string,
  upgrade: RawWebSocketUpgrade,
): Promise<Response | undefined> {
  return await upgrade();
}
