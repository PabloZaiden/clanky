/**
 * Serializes registration and key lifecycle mutations for each SSH server.
 */

import { KeyedOperationQueue } from "../utils/keyed-operation-queue";

const operations = new KeyedOperationQueue();

export async function withSshServerOperation<T>(
  serverId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return await operations.run(serverId, operation);
}
