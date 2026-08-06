/**
 * Bounded coordination for SSH connection establishment.
 *
 * The gate only covers handshakes and ACP initialization. It is released
 * before a ready ACP process starts handling prompts or remote commands.
 */

import { getSshReliabilityPolicy } from "./ssh-reliability-policy";

interface ConnectionWaiter {
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
}

interface TargetQueue {
  active: number;
  waiters: ConnectionWaiter[];
}

export class SshConnectionGate {
  private readonly queues = new Map<string, TargetQueue>();

  constructor(private readonly maxConcurrentConnections: number = getSshReliabilityPolicy().maxConcurrentHandshakes) {
    if (!Number.isInteger(maxConcurrentConnections) || maxConcurrentConnections < 1) {
      throw new Error("SSH connection gate requires at least one concurrent connection");
    }
  }

  acquire(targetKey: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("SSH connection acquisition was aborted"));
    }

    const queue = this.queues.get(targetKey) ?? { active: 0, waiters: [] };
    this.queues.set(targetKey, queue);

    return new Promise<() => void>((resolve, reject) => {
      const waiter: ConnectionWaiter = {
        signal,
        resolve: (release) => {
          if (waiter.onAbort && signal) {
            signal.removeEventListener("abort", waiter.onAbort);
          }
          resolve(release);
        },
        reject: (error) => {
          if (waiter.onAbort && signal) {
            signal.removeEventListener("abort", waiter.onAbort);
          }
          reject(error);
        },
      };
      waiter.onAbort = () => {
        const index = queue.waiters.indexOf(waiter);
        if (index >= 0) {
          queue.waiters.splice(index, 1);
        }
        waiter.reject(signal?.reason ?? new Error("SSH connection acquisition was aborted"));
        this.cleanupQueue(targetKey, queue);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      queue.waiters.push(waiter);
      this.drain(targetKey, queue);
    });
  }

  getActiveCount(targetKey: string): number {
    return this.queues.get(targetKey)?.active ?? 0;
  }

  getWaitingCount(targetKey: string): number {
    return this.queues.get(targetKey)?.waiters.length ?? 0;
  }

  private drain(targetKey: string, queue: TargetQueue): void {
    while (queue.active < this.maxConcurrentConnections && queue.waiters.length > 0) {
      const waiter = queue.waiters.shift();
      if (!waiter) {
        break;
      }
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new Error("SSH connection acquisition was aborted"));
        continue;
      }

      queue.active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        queue.active -= 1;
        this.drain(targetKey, queue);
        this.cleanupQueue(targetKey, queue);
      });
    }
    this.cleanupQueue(targetKey, queue);
  }

  private cleanupQueue(targetKey: string, queue: TargetQueue): void {
    if (queue.active === 0 && queue.waiters.length === 0 && this.queues.get(targetKey) === queue) {
      this.queues.delete(targetKey);
    }
  }
}

export const sshConnectionGate = new SshConnectionGate();
