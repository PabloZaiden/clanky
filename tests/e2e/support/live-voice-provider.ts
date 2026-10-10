/**
 * Deterministic GPT-Live network peer for the control-chat voice journey.
 */

export interface LiveFixture {
  id: string;
  stage: number;
  streaming: boolean;
  active: boolean;
  mode: "steer" | "hold" | "cut" | "question" | "ordinary";
  waiting?: boolean;
  questionId?: string;
  queuedId?: string;
  socket?: Bun.ServerWebSocket<LiveFixture>;
}

function send(session: LiveFixture, event: Record<string, unknown>): void {
  session.socket?.send(JSON.stringify(event));
}

function responseEvent(session: LiveFixture, event: Record<string, unknown>): void {
  send(session, { type: "response.event", delegation_id: `${session.id}-${session.stage}`, event });
}

function pump(session: LiveFixture): void {
  if (session.mode === "cut") { session.socket?.close(); return; }
  if (session.active || session.stage > 2 || ((session.mode === "hold" || session.mode === "ordinary") && session.stage > 0)
    || (session.stage === 1 && !(session.mode === "question" ? session.waiting : session.streaming))) return;
  session.active = true;
  const delegationId = `${session.id}-${session.stage}`;
  send(session, {
    type: "session.delegation.created",
    delegation: { id: delegationId, target: "responses", response_id: delegationId },
  });
  responseEvent(session, { type: "response.created", response: { id: delegationId } });
  const action = session.mode === "ordinary"
    ? { name: "send", arguments: { message: "Describe the ordinary Live chat request." } }
    : session.mode === "question"
    ? session.stage === 0
      ? { name: "send", arguments: { message: "Ask one Live question, then list the workspaces." } }
      : session.stage === 1 ? { name: "get_status", arguments: {} }
        : { name: "answer_question", arguments: { requestId: session.questionId, answers: [["Names only"]] } }
    : session.stage === 0
    ? { name: "send", arguments: { message: "Wait for a steering instruction, then list workspaces for the Live caller." } }
    : session.stage === 1
      ? { name: "send", arguments: { message: `Live steering request ${session.id}: include the workspace name.` } }
      : { name: "steer", arguments: { inputId: session.queuedId } };
  for (const [index, tool] of [{ name: "get_status", arguments: {} }, action].entries()) {
    const event = {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: `${delegationId}-${index}`, name: tool.name, arguments: JSON.stringify(tool.arguments) },
    };
    responseEvent(session, event);
    responseEvent(session, event);
  }
  responseEvent(session, { type: "response.completed", response: { id: delegationId, output: [] } });
}

export const liveFixtureWebSocket = {
  open(socket: Bun.ServerWebSocket<LiveFixture>) {
    socket.data.socket = socket;
    send(socket.data, { type: "session.started" });
    send(socket.data, { type: "session.input_transcript.delta", delta: "List the workspaces, and steer the active agent to include their names." });
    send(socket.data, { type: "session.output_transcript.delta", delta: "I will ask your workspace agent and keep you updated." });
  },
  message(socket: Bun.ServerWebSocket<LiveFixture>, raw: string | Buffer) {
    const event = JSON.parse(String(raw));
    const session = socket.data;
    if (event.type === "session.close") {
      send(session, { type: "session.closed" });
      socket.close();
      return;
    }
    if (event.type === "session.thinking.append") {
      session.streaming ||= String(event.content).includes('"status":"streaming"');
      session.waiting ||= String(event.content).includes('"status":"waiting"');
      pump(session);
    }
    if (event.type === "response.item.create") {
      const result = JSON.parse(event.item.output);
      if (session.mode === "question") session.questionId ??= result.state?.questions?.[0]?.requestId;
      if (session.mode === "steer" && session.stage === 1 && event.item.call_id.endsWith("-1")) {
        session.queuedId = result.state?.queued?.find((input: { content: string }) =>
          input.content.includes(`Live steering request ${session.id}`))?.id;
        if (!session.queuedId) {
          send(session, { type: "error", code: "fixture_queue_not_admitted" });
        }
      }
    }
    if (event.type === "response.create") {
      responseEvent(session, { type: "response.in_progress", response: { id: `${session.id}-final-${session.stage}` } });
      responseEvent(session, { type: "response.completed", response: { id: `${session.id}-final-${session.stage}`, output: [] } });
      session.stage++;
      session.active = false;
      pump(session);
    }
  },
};
