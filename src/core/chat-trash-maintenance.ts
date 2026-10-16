/**
 * A single startup/daily Trash sweep with deterministic shutdown.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import { runForEachActiveUser } from "./background-users";
import { chatManager } from "./chat-manager";

const log = createLogger("chat-trash-maintenance");
let timer: Timer | undefined;
let running: Promise<void> | undefined;

export function sweepChatTrash(): Promise<void> {
  if (!running) {
    running = runForEachActiveUser(async () => {
      try {
        await chatManager.expireTrash();
      } catch (error) {
        log.error("Chat Trash sweep failed", { error: String(error) });
      }
    }).finally(() => { running = undefined; });
  }
  return running;
}

export function startChatTrashMaintenance(): void {
  if (!timer) {
    // Scheduled work owns its error handling and reports failures in server logs.
    timer = setInterval(() => { void sweepChatTrash(); }, 24 * 60 * 60 * 1000);
    timer.unref();
  }
}

export async function stopChatTrashMaintenance(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await running;
}
