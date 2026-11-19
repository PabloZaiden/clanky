/**
 * External peer for the Claude SDK's native stream-json/control protocol.
 */
import { createInterface } from "node:readline";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SECRET_TOOL, consumeSecretFile, secretRequest } from "./secret-file";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const sessionId = argument("--session-id") ?? argument("--resume") ?? crypto.randomUUID();
const directory = process.cwd();
const project = join(process.env["CLAUDE_CONFIG_DIR"] ?? join(process.env["HOME"]!, ".claude"),
  "projects", directory.replace(/[^a-zA-Z0-9-]/g, "-"));
const path = join(project, `${sessionId}.jsonl`);
const persistent = !process.argv.includes("--no-session-persistence");
const model = argument("--model") ?? "claude-sanity";
const pending = new Map<string, ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>>();
let hooks: Array<{ hookCallbackIds: string[] }> = [];
let tools: Array<{ name: string }> = [];
let parentUuid: string | null = null;
let processing = false;
let tokens = 0;

function send(value: Record<string, unknown>): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function event(value: Record<string, unknown>, persist = false): Promise<void> {
  const row = {
    ...value, uuid: value["uuid"] ?? crypto.randomUUID(), session_id: sessionId,
    timestamp: new Date().toISOString(), parent_tool_use_id: null,
  };
  if (persist && persistent) {
    await mkdir(project, { recursive: true });
    await appendFile(path, `${JSON.stringify({
      ...row, sessionId, cwd: directory, parentUuid, isSidechain: false, version: "2.1.322",
    })}\n`);
    parentUuid = String(row.uuid);
  }
  send(row);
}

async function request(value: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = crypto.randomUUID();
  const response = Promise.withResolvers<Record<string, unknown>>();
  pending.set(id, response);
  send({ type: "control_request", request_id: id, request: value });
  return await response.promise;
}

async function call(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (!tools.some((tool) => tool.name === name)) throw new Error(`Claude native tool ${name} is unavailable. Advertised tools: ${tools.map((tool) => tool.name).join(", ")}.`);
  const id = crypto.randomUUID();
  const nativeName = `mcp__clanky__${name}`;
  await event({
    type: "assistant", message: {
      id: crypto.randomUUID(), role: "assistant", model,
      content: [{ type: "tool_use", id, name: nativeName, input }],
    },
  }, true);
  for (const hook of hooks) for (const callback_id of hook.hookCallbackIds) {
    const response = await request({
      subtype: "hook_callback", callback_id, tool_use_id: id,
      input: {
        hook_event_name: "PreToolUse", session_id: sessionId, cwd: directory,
        transcript_path: path, tool_name: nativeName, tool_input: input, tool_use_id: id,
        mcp_server: { name: "clanky", source: "sdk" },
      },
    });
    const output = response["hookSpecificOutput"];
    if (record(output) && output["permissionDecision"] === "deny") throw new Error(String(output["permissionDecisionReason"]));
  }
  const response = await request({
    subtype: "mcp_message", server_name: "clanky", message: {
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: input },
    },
  });
  const mcp = response["mcp_response"];
  if (!record(mcp) || !record(mcp["result"]) || !Array.isArray(mcp["result"]["content"])) throw new Error("Invalid Claude MCP result.");
  const content = mcp["result"]["content"];
  await event({
    type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
    tool_use_result: content,
  }, true);
  const text = content.filter(record).filter((block) => block["type"] === "text")
    .map((block) => String(block["text"])).join("\n");
  return JSON.parse(text);
}

async function execute(frame: Record<string, unknown>): Promise<void> {
  if (processing) throw new Error("The Claude native journey sent overlapping ordinary turns.");
  processing = true;
  await event({ type: "system", subtype: "session_state_changed", state: "running", sdk_host_only: true });
  const message = frame["message"];
  if (!record(message)) throw new Error("Invalid Claude user input.");
  const content = message["content"];
  const prompt = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(record).filter((block) => block["type"] === "text").map((block) => String(block["text"])).join("\n") : "";
  await event({ type: "system", subtype: "init", model }, false);
  await event({ type: "system", subtype: "background_tasks_changed", tasks: [] }, false);
  await event({ type: "user", message, uuid: frame["uuid"] }, true);
  if (prompt.startsWith("Wait for my plan quota to reset at ")) {
    const reset = Date.parse(prompt.slice("Wait for my plan quota to reset at ".length));
    if (!Number.isFinite(reset)) throw new Error("A quota reset timestamp is required.");
    const explanation = "Your plan usage limit has been reached.";
    await event({ type: "rate_limit_event", rate_limit_info: {
      status: "rejected", rateLimitType: "five_hour", resetsAt: reset / 1000,
    } });
    await event({ type: "assistant", error: "rate_limit", message: {
      id: crypto.randomUUID(), role: "assistant", model, content: [{ type: "text", text: explanation }],
    } }, true);
    processing = false;
    await event({ type: "result", subtype: "error_during_execution", is_error: true,
      errors: [explanation], queued_turn_count: 0, modelUsage: {} });
    await event({ type: "system", subtype: "session_state_changed", state: "idle", sdk_host_only: true });
    return;
  }
  let answer: string;
  const secret = secretRequest(prompt);
  if (secret) answer = await consumeSecretFile(await call(SECRET_TOOL, secret));
  else {
    const requests = prompt.split("\n").filter((line) => line.startsWith("Control request: "))
      .flatMap((line): Array<{ name: string; input: Record<string, unknown> }> => JSON.parse(line.slice("Control request: ".length)));
    const outputs = [];
    for (const entry of requests) outputs.push(await call(entry.name, entry.input));
    answer = requests.length ? JSON.stringify(outputs) : `Agent received: ${prompt}`;
  }
  const id = crypto.randomUUID();
  await event({
    type: "assistant", message: { id, role: "assistant", model, content: [{ type: "text", text: answer }] },
  }, true);
  tokens += 10;
  processing = false;
  await event({
    type: "result", subtype: "success", is_error: false, result: answer,
    queued_turn_count: 0, user_message_uuid: frame["uuid"],
    modelUsage: { [model]: { inputTokens: tokens, outputTokens: tokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  });
  await event({ type: "system", subtype: "session_state_changed", state: "idle", sdk_host_only: true });
}

async function dispatch(frame: Record<string, unknown>): Promise<void> {
  if (frame["type"] === "control_response") {
    const response = frame["response"];
    if (!record(response)) throw new Error("Invalid SDK callback response.");
    const id = String(response["request_id"]);
    const deferred = pending.get(id);
    if (!deferred) throw new Error("Unexpected SDK callback response.");
    pending.delete(id);
    if (response["subtype"] === "error") deferred.reject(new Error(String(response["error"])));
    else deferred.resolve(record(response["response"]) ? response["response"] : {});
    return;
  }
  if (frame["type"] === "user") {
    void execute(frame).catch(async (error: unknown) => {
      processing = false;
      await event({ type: "result", subtype: "error_during_execution", is_error: true, errors: [error instanceof Error ? error.message : String(error)], modelUsage: {} });
    });
    return;
  }
  const input = frame["request"];
  if (frame["type"] !== "control_request" || !record(input)) throw new Error("Invalid SDK control request.");
  let response: Record<string, unknown> = {};
  switch (input["subtype"]) {
    case "initialize": {
      const nativeHooks = input["hooks"];
      if (record(nativeHooks) && Array.isArray(nativeHooks["PreToolUse"])) {
        hooks = nativeHooks["PreToolUse"].filter((hook): hook is { hookCallbackIds: string[] } =>
          record(hook) && Array.isArray(hook["hookCallbackIds"]));
      }
      const manifests = input["sdkMcpServerManifests"];
      const manifest = record(manifests) ? manifests["clanky"] : undefined;
      const catalog = record(manifest) ? manifest["toolsListResult"] : undefined;
      tools = record(catalog) && Array.isArray(catalog["tools"])
        ? catalog["tools"].filter((tool): tool is { name: string } => record(tool) && typeof tool["name"] === "string") : [];
      response = {
        commands: [], agents: [], models: [{ value: "claude-sanity", displayName: "Claude sanity", description: "External native fixture", supportsEffort: true, supportedEffortLevels: ["low", "high"] }],
        hooks_applied: true, hook_on_failure_supported: true,
        sdk_mcp_manifests_parked: record(manifest) ? { clanky: "parked" } : {},
        claude_code_version: "2.1.322", session_state: "idle",
      };
      break;
    }
    case "mcp_status":
      response = { mcpServers: tools.length ? [{ name: "clanky", status: "connected", transport: "sdk", source: "sdk", tools }] : [] };
      break;
    case "set_model":
    case "apply_flag_settings":
    case "interrupt":
      break;
    default:
      throw new Error(`Unsupported SDK control method: ${String(input["subtype"])}`);
  }
  send({ type: "control_response", response: { subtype: "success", request_id: frame["request_id"], response } });
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame: unknown = JSON.parse(line);
  if (!record(frame)) throw new Error("Invalid Claude stream-json frame.");
  await dispatch(frame);
}
