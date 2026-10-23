import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { listActiveUsers } from "../persistence/users";
import { runWithExecutionOwner } from "../context/user-context";

export async function runForEachActiveUser(
  callback: (user: CurrentUser) => Promise<void>,
): Promise<void> {
  for (const user of listActiveUsers()) {
    await runWithExecutionOwner(user, () => callback(user));
  }
}
