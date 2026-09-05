import { test } from "bun:test";
import { createConnection } from "node:net";
import {
  createWorkerHandoffParent,
} from "../../src/core/mesh-worker-handoff";

test("worker handoff preserves messages sent before the parent starts waiting", async () => {
  const handoff = await createWorkerHandoffParent();
  const child = createConnection(handoff.socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("connect", resolve);
      child.once("error", reject);
    });
    child.write(`ready:${handoff.token}\n`);
    await handoff.waitForReady();

    const proceed = new Promise<void>((resolve, reject) => {
      child.on("data", (chunk) => {
        if (chunk.toString("utf8").includes(`proceed:${handoff.token}`)) {
          resolve();
        }
      });
      child.once("error", reject);
    });
    handoff.proceed();
    await proceed;

    child.write(`started:${handoff.token}\n`);
    await handoff.waitForStarted();
  } finally {
    child.destroy();
    await handoff.close();
  }
});
