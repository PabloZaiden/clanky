import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { listActiveUsers } from "../persistence/users";
import { runWithCurrentUser } from "./user-context";

export async function runForEachActiveUser(
  callback: (user: CurrentUser) => Promise<void>,
): Promise<void> {
  for (const user of listActiveUsers()) {
    await runWithCurrentUser(user, () => callback(user));
  }
}
