/**
 * Runs the external Codex app-server fixture over newline-delimited JSON-RPC.
 */

import { createInterface } from "node:readline";
import { join } from "node:path";
import { CodexMethodDispatcher } from "./codex-dispatcher";
import { CodexJsonRpcSession, parseJsonRpcMessage, type JsonRpcMessage } from "./codex-json-rpc";
import { buildTurn } from "./codex-protocol";
import { CodexFixtureStore, type ActiveTurn } from "./codex-state";
import { runCodexTurn } from "./codex-turn-runner";

function errorResponse(error: unknown): { code: number; message: string } {
  const code = typeof error === "object" && error !== null && "code" in error
    && typeof error["code"] === "number"
    ? error["code"]
    : -32000;
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function serveCodexAppServer(homeDirectory: string): Promise<void> {
  const store = await CodexFixtureStore.open(join(homeDirectory, ".codex", "e2e-control-threads.json"));
  const dispatcher = new CodexMethodDispatcher(store);
  const rpc = new CodexJsonRpcSession((message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });
  const turnTasks = new Set<Promise<void>>();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of input) {
    let frame: JsonRpcMessage;
    try {
      frame = parseJsonRpcMessage(JSON.parse(line) as unknown);
    } catch (error) {
      process.stderr.write(`codex-e2e: invalid JSON-RPC frame: ${String(error)}\n`);
      process.exitCode = 1;
      break;
    }
    await handleFrame(frame, dispatcher, store, rpc, turnTasks);
  }

  rpc.close();
  await Promise.allSettled(turnTasks);
}

async function handleFrame(
  frame: ReturnType<typeof parseJsonRpcMessage>,
  dispatcher: CodexMethodDispatcher,
  store: CodexFixtureStore,
  rpc: CodexJsonRpcSession,
  turnTasks: Set<Promise<void>>,
): Promise<void> {
  if (!frame.method) {
    rpc.receiveResponse(frame);
    return;
  }
  if (frame.method === "initialized" || frame.id === undefined) {
    return;
  }

  try {
    const dispatched = await dispatcher.dispatch(frame.method, frame.params);
    rpc.respond(frame.id, dispatched.result);
    const activeTurn = dispatched.turn;
    if (activeTurn) {
      const task = runCodexTurn(activeTurn, store, rpc)
        .catch(async (error: unknown) => {
          await failTurn(activeTurn, error, store, rpc);
        })
        .finally(() => turnTasks.delete(task));
      turnTasks.add(task);
    }
  } catch (error) {
    rpc.respondWithError(frame.id, errorResponse(error));
  }
}

async function failTurn(
  active: ActiveTurn,
  error: unknown,
  store: CodexFixtureStore,
  rpc: CodexJsonRpcSession,
): Promise<void> {
  try {
    await store.failTurn(active, error);
    rpc.notify("turn/completed", {
      threadId: active.thread.id,
      turn: buildTurn(active.turn),
    });
  } catch (cleanupError) {
    process.stderr.write(
      `codex-e2e: failed to persist turn failure: ${String(cleanupError)} (original: ${String(error)})\n`,
    );
  }
}
