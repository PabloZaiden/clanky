/**
 * Serializes SSH server/key mutations with dependent preview registration.
 */

import { KeyedOperationQueue } from "../utils/keyed-operation-queue";

const operations = new KeyedOperationQueue();

export async function withSshServerOperation<T>(
  serverId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return await operations.run(serverId, operation);
}
