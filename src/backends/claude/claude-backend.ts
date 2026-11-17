import {
  createSdkMcpServer, deleteSession, getSessionInfo, getSessionMessages,
  getSubagentMessages, listSubagents,
  type ModelInfo as ClaudeModel, type SDKMessage, type SDKUserMessage,
  type PermissionResult, type HookCallback, type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createLogger } from "@pablozaiden/webapp/server";
import type {
  Backend, BackendConnectionConfig, AgentSession, CreateSessionOptions, ConfigOption,
  PromptInput, AgentResponse,
} from "../types";
import type {
  HarnessControl, HarnessCapabilities, HarnessConversationBinding, HarnessActivitySnapshot,
  HarnessActivityStopResult, HarnessCleanupResult, HarnessSteerRequest, HarnessInputAdmission,
  HarnessInputRecoveryRequest,
} from "@/shared/harness-control";
import type { HarnessEvent, HarnessEventScope } from "@/shared/harness-events";
import type { HarnessUsageSnapshot, TokenCounts } from "@/shared/harness-usage";
import type { ClankyControlContext } from "@/shared/clanky-control";
import type { ControlToolConnection } from "../../core/control-tool-transport";
import { buildAgentInstructions } from "@/shared/agent-instructions";
import { controlResultContent } from "@/shared/control-tool-result";
import { RequestSecretSchema } from "@/contracts/schemas/harness-secret";
import { HarnessError } from "../harness-errors";
import { HarnessEventHub } from "../harness-event-hub";
import { requireMatchingHarnessBinding } from "../harness-binding";
import { consumeHarnessPrompt } from "../harness-prompt";
import { NativeHistoryReader } from "../native-history-reader";
import { NativeSessionHistory } from "../native-session-history";
import { NativeSubagentHistory } from "../native-subagent-history";
import { ClankyControlToolService } from "../clanky-control-tools";
import { SecretCoordinator, secretToolDefinition } from "../secret-coordinator";
import { ClaudeRuntime, type ClaudeProcess } from "./runtime";
import { ClaudeEventTranslator, isRecord } from "./event-translator";

const log = createLogger("backend:claude");
const QuestionSchema = z.object({
  questions: z.array(z.object({
    question: z.string(), header: z.string().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
    multiSelect: z.boolean().optional(),
  })).min(1),
});

interface Conversation {
  info: AgentSession & { binding: HarnessConversationBinding };
  native: ClaudeProcess;
  translator: ClaudeEventTranslator;
  pump: Promise<void>;
  closing: boolean;
  admitting: boolean;
  active?: { context?: ClankyControlContext; abort: AbortController };
  modelUsage?: Extract<SDKMessage, { type: "result" }>["modelUsage"];
  receivedInputs: Set<string>;
  activityChanged: Set<() => void>;
  faulted?: boolean;
  pendingTerminal?: Extract<HarnessEvent, { type: "prompt.complete" | "error" }>;
  initialState: "idle" | "running" | "requires_action";
}

interface PendingQuestion {
  sessionId: string;
  response: ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>;
  input: Record<string, unknown>;
  headers: string[];
  scope: HarnessEventScope;
}

export class ClaudeBackend implements Backend {
  readonly name = "claude";
  private readonly events = new HarnessEventHub();
  private readonly secrets = new SecretCoordinator(this.events);
  private readonly history = new NativeHistoryReader();
  private readonly childHistory = new NativeHistoryReader<HarnessEvent>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly operations = new Set<Promise<AgentSession>>();
  private readonly resuming = new Map<string, Promise<AgentSession>>();
  private runtime?: ClaudeRuntime;
  private models: ClaudeModel[] = [];
  private directory = "";
  private control?: ControlToolConnection;
  private controlTools?: ClankyControlToolService;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private startupAbort?: AbortController;

  readonly harness: HarnessControl = {
    capabilities: {
      adapter: "claude", experimental: true, steering: "active-session", activity: "native",
      stopScopes: ["child-execution", "command"], questionPolicy: "session",
      clankyControlTools: true, secretFiles: 1, history: "completed",
      subagentHistory: "completed", usage: "tokens",
    } satisfies HarnessCapabilities,
    getUsage: (id) => this.getUsage(id),
    getActivity: (id) => this.getActivity(id),
    stopActivity: (id, activity) => this.stopActivity(id, activity),
    steer: (id, request) => this.steer(id, request),
    reconcileInput: (id, request) => this.reconcileInput(id, request),
    settleOwnedWork: (id) => this.settleOwnedWork(id),
  };

  connect(config: BackendConnectionConfig, signal?: AbortSignal): Promise<void> {
    if (this.opening || this.runtime) throw new HarnessError("harness_request_failed", "Claude is already connected or starting.");
    if (config.mesh) throw new HarnessError("harness_unsupported_feature", "Claude must run on the selected execution host.");
    this.directory = config.directory;
    this.control = config.control;
    this.startupAbort = new AbortController();
    const abort = () => this.startupAbort?.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.opening = (async () => {
      await this.closing;
      const runtime = new ClaudeRuntime(config.directory, { ...config.env, ...config.managedEnvironment });
      const native = runtime.open({ abortController: this.startupAbort, persistSession: false, tools: [] });
      try {
        await native.query.initializationResult();
        this.models = await native.query.supportedModels();
        if (this.startupAbort?.signal.aborted) throw new HarnessError("harness_connection_aborted", "Claude startup was cancelled.");
        this.runtime = runtime;
        this.history.open();
        this.childHistory.open();
      } finally {
        await native.close();
      }
    })().finally(() => {
      signal?.removeEventListener("abort", abort);
      this.startupAbort = undefined;
      this.opening = undefined;
    });
    return this.opening;
  }

  disconnect(): Promise<void> {
    return this.closing ??= (async () => {
      this.startupAbort?.abort();
      const errors: unknown[] = [];
      try { await this.opening; } catch (error) {
        if (!(error instanceof HarnessError && error.code === "harness_connection_aborted")) errors.push(error);
      }
      await Promise.allSettled(this.operations);
      this.controlTools?.close();
      for (const id of this.conversations.keys()) {
        try { await this.closeSession(id); } catch (error) { errors.push(error); }
      }
      try { await Promise.all([this.history.close(), this.childHistory.close()]); } catch (error) { errors.push(error); }
      this.runtime = undefined;
      this.controlTools = undefined;
      this.events.closeAll();
      if (errors.length) throw new AggregateError(errors, "Claude teardown failed.");
    })().finally(() => { this.closing = undefined; });
  }

  isConnected(): boolean { return this.runtime !== undefined && !this.closing; }
  getDirectory(): string { return this.directory; }
  getConnectionInfo(): null { return null; }
  getSdkClient(): unknown { return this.requireRuntime(); }
  abortAllSubscriptions(reason?: Error): void { this.events.closeAll(reason); }

  createSession(options: CreateSessionOptions): Promise<AgentSession> {
    return this.operation(async () => {
      if (!options.ownership || options.directory !== this.directory) {
        throw new HarnessError("harness_session_not_owned", "Claude conversations require matching Clanky ownership and directory.");
      }
      if (options.model) this.requireModel(options.model);
      const binding: HarnessConversationBinding = {
        ...options.ownership, adapter: "claude", nativeId: crypto.randomUUID(), directory: options.directory,
      };
      await this.saveBinding(binding);
      try { return await this.attach(binding, options.model, false, options.title); } catch (error) {
        await unlink(this.bindingPath(binding.nativeId));
        throw error;
      }
    });
  }

  resumeSession(binding: HarnessConversationBinding): Promise<AgentSession> {
    if (binding.adapter !== "claude" || binding.directory !== this.directory) {
      throw new HarnessError("harness_session_not_owned", "The Claude binding does not match this runtime.");
    }
    const existing = this.conversations.get(binding.nativeId);
    if (existing) {
      requireMatchingHarnessBinding(JSON.stringify(existing.info.binding), binding);
      return Promise.resolve(existing.info);
    }
    const previous = this.resuming.get(binding.nativeId);
    if (previous) return previous.then((session) => {
      requireMatchingHarnessBinding(JSON.stringify(session.binding), binding);
      return session;
    });
    const pending = this.operation(async () => {
      let raw: string;
      try { raw = await readFile(this.bindingPath(binding.nativeId), "utf8"); } catch (error) {
        if (isRecord(error) && error["code"] === "ENOENT") throw new HarnessError("harness_session_not_found", "The Clanky-owned Claude session is unavailable.");
        throw error;
      }
      requireMatchingHarnessBinding(raw, binding);
      if (!await getSessionInfo(binding.nativeId, { dir: binding.directory })) {
        throw new HarnessError("harness_session_not_found", "The native Claude transcript is unavailable.");
      }
      await this.saveBinding(binding);
      return await this.attach(binding, undefined, true);
    }).finally(() => this.resuming.delete(binding.nativeId));
    this.resuming.set(binding.nativeId, pending);
    return pending;
  }

  async getSession(id: string): Promise<AgentSession | null> { return this.conversations.get(id)?.info ?? null; }

  async deleteSession(id: string): Promise<void> {
    const binding = this.get(id).info.binding;
    const cleanup = await this.settleOwnedWork(id);
    if (cleanup.status !== "settled") throw new HarnessError("harness_request_failed", "Claude's owned work has not settled.");
    await this.history.forget(id);
    await this.closeSession(id);
    if (await getSessionInfo(id, { dir: binding.directory })) await deleteSession(id, { dir: binding.directory });
    await unlink(this.bindingPath(id));
  }

  async sendPrompt(id: string, prompt: PromptInput): Promise<AgentResponse> {
    const response = await consumeHarnessPrompt(this, id, prompt);
    if (!response.id) throw new HarnessError("harness_request_failed", "Claude produced no principal response.");
    return response;
  }

  async sendPromptAsync(id: string, prompt: PromptInput): Promise<void> {
    const conversation = this.get(id);
    if (conversation.admitting || this.processing(conversation)) throw new HarnessError("harness_session_busy", "Claude is already processing or admitting input.");
    conversation.admitting = true;
    try {
      const input = this.input(id, prompt);
      if (prompt.model) await this.applyModel(conversation, prompt.model.modelID, prompt.model.variant);
      this.beginTurn(conversation, prompt.controlContext);
      conversation.translator.interrupted = false;
      conversation.translator.processing = true;
      await conversation.native.send(input);
    } catch (error) {
      this.endTurn(conversation);
      throw error;
    } finally {
      conversation.admitting = false;
      this.finishIdleTurn(conversation);
    }
  }

  async subscribeToEvents(id: string) { this.get(id); return this.events.subscribe(id); }

  async abortSession(id: string): Promise<void> {
    const conversation = this.get(id);
    conversation.translator.interrupted = true;
    this.endTurn(conversation);
    this.cancelQuestions(id);
    await conversation.native.query.interrupt();
  }

  async replyToPermission(_id: string, _response: string): Promise<void> {
    throw new HarnessError("harness_unsupported_feature", "Native permissions are automatically approved.");
  }

  async replyToQuestion(id: string, answers: string[][]): Promise<void> {
    const question = this.questions.get(id);
    if (!question) throw new HarnessError("harness_question_closed", "The Claude question is no longer pending.");
    if (answers.length !== question.headers.length) throw new HarnessError("harness_question_invalid", "Answer each Claude question.");
    const result = Object.fromEntries(question.headers.map((header, index) => [header, answers[index]!.join(", ")]));
    this.questions.delete(id);
    this.events.publish(question.sessionId, { type: "question.resolved", requestId: id, outcome: "answered", scope: question.scope });
    question.response.resolve({ ...question.input, answers: result });
  }

  replyToSecret(id: string, value: string | null): Promise<void> { return this.secrets.reply(id, value); }

  async setConfigOption(id: string, configId: string, value: string): Promise<ConfigOption[]> {
    const conversation = this.get(id);
    if (conversation.admitting || this.processing(conversation)) throw new HarnessError("harness_session_busy", "Claude is processing.");
    conversation.admitting = true;
    try {
      if (configId === "model") await this.applyModel(conversation, value);
      else if (configId === "reasoning_effort" && conversation.info.model) await this.applyModel(conversation, conversation.info.model, value);
      else throw new HarnessError("harness_invalid_model_option", "The Claude option is unsupported.");
      return conversation.info.configOptions ?? [];
    } finally { conversation.admitting = false; }
  }

  async setSessionModel(id: string, model: string): Promise<void> { await this.setConfigOption(id, "model", model); }

  async getModels(_directory: string) {
    this.requireRuntime();
    return this.models.map((model) => ({
      providerID: "claude", providerName: "Claude Agent", modelID: model.value,
      modelName: model.resolvedModel && !/claude|anthropic/i.test(model.resolvedModel)
        ? `${model.displayName} (${model.resolvedModel})` : model.displayName,
      connected: true, variants: model.supportedEffortLevels?.length ? ["", ...model.supportedEffortLevels] : [],
    }));
  }

  async getModelVariants(_directory: string, model: string): Promise<string[]> {
    const native = this.requireModel(model);
    return native.supportedEffortLevels?.length ? ["", ...native.supportedEffortLevels] : [];
  }

  async readSessionHistory(id: string, cursor?: string) {
    const conversation = this.get(id);
    return await this.history.read({
      sessionId: id, cursor, source: () => this.historySource(conversation),
      processing: async () => this.processing(conversation),
    });
  }

  async readSubagentHistory(id: string, activityId: string, cursor?: string) {
    const conversation = this.get(id);
    const activity = conversation.translator.activities.get(activityId);
    if ((!activity || activity.kind !== "subagent") && !(await listSubagents(id, { dir: this.directory })).includes(activityId)) {
      throw new HarnessError("harness_activity_not_owned", "The Claude child transcript does not belong to this conversation.");
    }
    const page = await this.childHistory.read({
      sessionId: JSON.stringify([id, activityId]), cursor,
      source: () => this.childHistorySource(conversation, activityId),
      processing: async () => ["running", "waiting", "stopping"].includes(conversation.translator.activities.get(activityId)?.status ?? ""),
    });
    return { events: page.events, processing: page.principalProcessing, nextCursor: page.nextCursor };
  }

  private async attach(binding: HarnessConversationBinding, model?: string, resume = false, title?: string): Promise<AgentSession> {
    const runtime = this.requireRuntime();
    const translator = new ClaudeEventTranslator(binding.nativeId);
    let conversation: Conversation | undefined;
    const current = () => {
      if (!conversation) throw new HarnessError("harness_session_not_owned", "The Claude conversation is not initialized.");
      return conversation;
    };
    const mcp = await this.nativeTools(binding, current);
    const guard: HookCallback = async (input, _toolUseId, { signal }) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      if (input.session_id !== binding.nativeId) {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "The native tool belongs to another conversation." } };
      }
      if (input.tool_name === "AskUserQuestion") {
        if (binding.questionPolicy !== "interactive" || !current().active) {
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Human input requires an active interactive turn." } };
        }
        if (!isRecord(input.tool_input)) throw new HarnessError("harness_question_invalid", "Claude supplied invalid question input.");
        const answers = await this.ask(current(), input.tool_input, input.agent_id, signal);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: answers } };
      }
      if (!input.tool_name.startsWith("mcp__clanky__")) return {};
      const active = conversation?.active;
      if (input.agent_id || !active || active.abort.signal.aborted || input.mcp_server?.source !== "sdk") {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Clanky tools require an active owned root turn." } };
      }
      return {};
    };
    const options: Options = {
      systemPrompt: {
        type: "preset", preset: "claude_code",
        append: buildAgentInstructions({ controlTools: binding.controlTools, htmlArtifacts: mcp?.htmlArtifacts === true }),
      },
      ...(model ? { model } : {}),
      ...(resume ? { resume: binding.nativeId } : { sessionId: binding.nativeId }),
      canUseTool: async (name, input, invocation): Promise<PermissionResult> => {
        if (name === "AskUserQuestion") {
          if (isRecord(input["answers"])) return { behavior: "allow", updatedInput: input };
          if (binding.questionPolicy !== "interactive") return { behavior: "deny", message: "Human input is unavailable in unattended executions." };
          const answers = await this.ask(current(), input, invocation.agentID, invocation.signal);
          return { behavior: "allow", updatedInput: answers };
        }
        return { behavior: "allow", updatedInput: input };
      },
      disallowedTools: binding.questionPolicy === "interactive" ? [] : ["AskUserQuestion"],
      ...(mcp ? { mcpServers: { clanky: mcp.server } } : {}),
      hooks: {
        PreToolUse: [{ matcher: "^(mcp__clanky__.*|AskUserQuestion)$", hooks: [guard], onFailure: "block" }],
      },
    };
    const native = runtime.open(options, (_state, sessionId) => {
      if (!conversation || sessionId !== binding.nativeId || conversation.closing) return;
      this.finishIdleTurn(conversation);
      this.events.publish(binding.nativeId, { type: "activity.changed", scope: { kind: "principal" } });
      for (const changed of conversation.activityChanged) changed();
    });
    conversation = {
      native, translator, info: { id: binding.nativeId, binding, model, title, createdAt: new Date().toISOString() },
      pump: Promise.resolve(), closing: false, admitting: false, receivedInputs: new Set(), activityChanged: new Set(),
      initialState: "running",
    };
    this.conversations.set(binding.nativeId, conversation);
    const attached = conversation;
    attached.pump = this.observe(attached);
    try {
      const initialized: unknown = await native.query.initializationResult();
      if (!isRecord(initialized) || !["idle", "running", "requires_action"].includes(String(initialized["session_state"]))) {
        throw new HarnessError("harness_runtime_unavailable", "Claude's native runtime does not expose authoritative session state.");
      }
      const state = initialized["session_state"];
      if (state === "idle" || state === "running" || state === "requires_action") attached.initialState = state;
      this.models = await native.query.supportedModels();
      if (mcp) {
        const status = (await native.query.mcpServerStatus()).find((server) => server.name === "clanky");
        if (status?.status !== "connected") throw new HarnessError("harness_runtime_unavailable", "Claude's owned Clanky tools are not ready.");
      }
      attached.info.configOptions = this.configOptions(attached);
      return attached.info;
    } catch (error) {
      await this.closeSession(binding.nativeId);
      throw error;
    }
  }

  private async observe(conversation: Conversation): Promise<void> {
    try {
      for await (const message of conversation.native.query) {
        if (message.type === "system" && message.subtype === "init") {
          const selected = this.models.find((model) => model.value === conversation.info.model);
          if (!selected || (selected.resolvedModel ?? selected.value) !== message.model) conversation.info.model = message.model;
        }
        if (message.type === "user" && message.uuid) {
          conversation.receivedInputs.add(message.uuid);
          if (conversation.receivedInputs.size > 1024) conversation.receivedInputs.delete(conversation.receivedInputs.values().next().value!);
        }
        if (message.type === "result") conversation.modelUsage = message.modelUsage;
        for (const event of conversation.translator.translate(message)) {
          if (event.scope.kind === "principal" && (event.type === "prompt.complete" || event.type === "error")) {
            if (event.type === "error" || conversation.pendingTerminal?.type !== "error") conversation.pendingTerminal = event;
            this.finishIdleTurn(conversation);
            continue;
          }
          this.events.publish(conversation.info.id, event);
          if (event.type === "activity.changed" || event.type === "prompt.complete" || event.type === "error") for (const changed of conversation.activityChanged) changed();
        }
      }
      if (!conversation.closing) throw new HarnessError("harness_transport_closed", "Claude's native observation closed unexpectedly.");
    } catch (error) {
      if (conversation.closing) return;
      conversation.faulted = true;
      this.endTurn(conversation);
      this.cancelQuestions(conversation.info.id);
      log.error("Claude native observation failed", { conversationId: conversation.info.id, errorType: error instanceof Error ? error.name : typeof error });
      this.events.failSession(conversation.info.id, error instanceof Error ? error : new Error("Claude native observation failed."));
      for (const changed of conversation.activityChanged) changed();
    }
  }

  private async nativeTools(binding: HarnessConversationBinding, current: () => Conversation) {
    const definitions = binding.controlTools ? await this.getControlTools().listTools({ chatId: binding.controlChatId }) : [];
    const secret = binding.questionPolicy === "interactive" && binding.secretFiles === 1;
    if (!definitions.length && !secret) return undefined;
    const tools = [...definitions, ...(secret ? [{ ...secretToolDefinition, inputSchema: z.toJSONSchema(RequestSecretSchema) }] : [])];
    const server = createSdkMcpServer({ name: "clanky", version: "1.0.0" });
    server.instance.server.registerCapabilities({ tools: {} });
    server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!tools.some((tool) => tool.name === request.params.name)) {
        throw new HarnessError("harness_session_not_owned", "The Clanky tool is not enabled for this conversation.");
      }
      const conversation = current();
      const active = conversation.active;
      if (!active || active.abort.signal.aborted || conversation.closing) throw new HarnessError("harness_session_not_owned", "Clanky tool calls require an active owned turn.");
      const value = request.params.name === secretToolDefinition.name && secret
        ? await this.secrets.request(binding, request.params.arguments, active.abort.signal)
        : await this.getControlTools().invoke(request.params.name, request.params.arguments, active.context, active.abort.signal);
      return { content: controlResultContent(value), isError: isRecord(value) && value["ok"] === false };
    });
    return { server, htmlArtifacts: definitions.some((tool) => tool.name === "clanky_html_render") };
  }

  private getControlTools(): ClankyControlToolService {
    if (!this.controlTools) {
      if (!this.control) throw new HarnessError("harness_runtime_unavailable", "Execution-owned Clanky control is unavailable.");
      this.controlTools = new ClankyControlToolService(this.control);
    }
    return this.controlTools;
  }

  private async ask(conversation: Conversation, input: Record<string, unknown>, agentId: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>> {
    const parsed = QuestionSchema.safeParse(input);
    if (!parsed.success) throw new HarnessError("harness_question_invalid", "Claude supplied an invalid question.");
    const requestId = crypto.randomUUID();
    const response = Promise.withResolvers<Record<string, unknown>>();
    const scope: HarnessEventScope = agentId ? { kind: "child", activityId: agentId } : { kind: "principal" };
    this.questions.set(requestId, {
      sessionId: conversation.info.id, response, input, scope,
      headers: parsed.data.questions.map((question) => question.question),
    });
    const abort = () => {
      if (this.questions.delete(requestId)) {
        this.events.publish(conversation.info.id, { type: "question.resolved", requestId, outcome: "cancelled", scope });
        response.reject(new HarnessError("harness_question_closed", "The native question ended."));
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else this.events.publish(conversation.info.id, {
      type: "question.asked", requestId, sessionId: conversation.info.id, blocking: true, responseMode: "callback", scope,
      questions: parsed.data.questions.map((question) => ({
        question: question.question, header: question.header ?? "", multiple: question.multiSelect,
        custom: true, options: (question.options ?? []).map((option) => ({ label: option.label, description: option.description ?? "" })),
      })),
    });
    try { return await response.promise; } finally {
      signal.removeEventListener("abort", abort);
      this.questions.delete(requestId);
    }
  }

  private cancelQuestions(id: string): void {
    for (const [requestId, question] of this.questions) {
      if (question.sessionId !== id) continue;
      this.questions.delete(requestId);
      this.events.publish(id, { type: "question.resolved", requestId, outcome: "cancelled", scope: question.scope });
      question.response.reject(new HarnessError("harness_question_closed", "The Claude question ended."));
    }
  }

  private beginTurn(conversation: Conversation, context?: ClankyControlContext): void {
    const binding = conversation.info.binding;
    if (context && (!binding.controlTools || context.chatId !== binding.controlChatId || !context.workspaceId || !context.turnId)) {
      throw new HarnessError("harness_session_not_owned", "The Clanky control turn does not match this Claude conversation.");
    }
    if (conversation.active) throw new HarnessError("harness_session_busy", "A Claude control turn is already active.");
    conversation.active = { context, abort: new AbortController() };
  }

  private endTurn(conversation: Conversation): void {
    conversation.active?.abort.abort();
    conversation.active = undefined;
    this.secrets.cancel(conversation.info.id);
  }

  private finishIdleTurn(conversation: Conversation): void {
    const terminal = conversation.pendingTerminal;
    if (!terminal || conversation.closing || conversation.faulted || this.processing(conversation)) return;
    conversation.pendingTerminal = undefined;
    this.endTurn(conversation);
    this.events.publish(conversation.info.id, terminal);
    for (const changed of conversation.activityChanged) changed();
  }

  private async applyModel(conversation: Conversation, value: string, variant?: string): Promise<void> {
    const model = this.requireModel(value);
    const effort = variant ? model.supportedEffortLevels?.find((effort) => effort === variant) : undefined;
    if (variant && !effort) throw new HarnessError("harness_invalid_model_option", "The Claude reasoning effort is unavailable.");
    await conversation.native.query.setModel(value);
    await conversation.native.query.applyFlagSettings({ effortLevel: effort ?? null });
    conversation.info.model = value;
    conversation.info.configOptions = this.configOptions(conversation, effort);
  }

  private configOptions(conversation: Conversation, effort?: string): ConfigOption[] {
    const options: ConfigOption[] = [{
      id: "model", name: "Model", category: "model", type: "select",
      currentValue: conversation.info.model ?? "",
      options: this.models.map((model) => ({ value: model.value, name: model.displayName })),
    }];
    const model = this.models.find((model) => model.value === conversation.info.model || model.resolvedModel === conversation.info.model);
    if (model?.supportedEffortLevels?.length) options.push({
      id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select",
      currentValue: effort ?? "", options: ["", ...model.supportedEffortLevels].map((value) => ({ value, name: value || "Default" })),
    });
    return options;
  }

  private requireModel(value: string): ClaudeModel {
    const model = this.models.find((model) => model.value === value || model.resolvedModel === value);
    if (!model) throw new HarnessError("harness_model_not_available", "The selected Claude model is unavailable.");
    return model;
  }

  private input(id: string, prompt: PromptInput, uuid: NonNullable<SDKUserMessage["uuid"]> = crypto.randomUUID(), priority?: SDKUserMessage["priority"]): SDKUserMessage {
    const content: Array<Exclude<NonNullable<SDKUserMessage["message"]["content"]>, string>[number]> = [];
    const image = (mimeType: string, data: string) => {
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) throw new HarnessError("harness_unsupported_feature", "Claude does not support this image format.");
      const media_type = mimeType === "image/png" ? "image/png" : mimeType === "image/jpeg" ? "image/jpeg" : mimeType === "image/gif" ? "image/gif" : "image/webp";
      content.push({ type: "image", source: { type: "base64", media_type, data } });
    };
    for (const part of prompt.parts) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
      else if (part.type === "image") {
        image(part.mimeType, part.data);
      } else if ("text" in part.resource) content.push({ type: "text", text: part.resource.text });
      else if (part.resource.mimeType?.startsWith("image/")) image(part.resource.mimeType, part.resource.blob);
      else if (part.resource.mimeType === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: part.resource.blob } });
      else throw new HarnessError("harness_unsupported_feature", "Binary resources must be materialized as execution-host file references.");
    }
    return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: id, uuid, ...(priority ? { priority } : {}) };
  }

  private async getUsage(id: string): Promise<HarnessUsageSnapshot> {
    const conversation = this.get(id);
    const tokens: TokenCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const usage of Object.values(conversation.modelUsage ?? {})) {
      tokens.inputTokens = (tokens.inputTokens ?? 0) + usage.inputTokens;
      tokens.outputTokens = (tokens.outputTokens ?? 0) + usage.outputTokens;
      tokens.cacheReadTokens = (tokens.cacheReadTokens ?? 0) + usage.cacheReadInputTokens;
      tokens.cacheWriteTokens = (tokens.cacheWriteTokens ?? 0) + usage.cacheCreationInputTokens;
      if (usage.thinkingTokens !== undefined) tokens.reasoningTokens = (tokens.reasoningTokens ?? 0) + usage.thinkingTokens;
    }
    return { observedAt: new Date().toISOString(), coverage: conversation.modelUsage ? "complete" : "partial", contributors: [{ id, tokens }] };
  }

  private async getActivity(id: string): Promise<HarnessActivitySnapshot> {
    if (!this.isConnected()) return { observation: "unavailable", reason: "disconnected" };
    const conversation = this.get(id);
    if (conversation.faulted) return { observation: "unavailable", reason: "gap" };
    return {
      observation: "available", coverage: conversation.translator.coverage,
      observedAt: new Date().toISOString(), principalProcessing: this.processing(conversation),
      activities: [...conversation.translator.activities.values()].map((activity) => ({ ...activity })),
    };
  }

  private async stopActivity(id: string, activityId: string): Promise<HarnessActivityStopResult> {
    const conversation = this.get(id);
    const activity = conversation.translator.activities.get(activityId);
    if (!activity || activity.ownership !== "owned" || !["subagent", "process"].includes(activity.kind)) throw new HarnessError("harness_activity_not_owned", "The Claude activity is not an owned execution.");
    if (["stopped", "completed", "failed"].includes(activity.status)) return { status: "stopped", activityId };
    await conversation.native.query.stopTask(activityId);
    return { status: ["stopped", "completed", "failed"].includes(activity.status) ? "stopped" : "stopping", activityId };
  }

  private async steer(id: string, request: HarnessSteerRequest): Promise<HarnessInputAdmission> {
    const conversation = this.get(id);
    if (request.expectedTurnId) return { status: "rejected", inputId: request.inputId, code: "turn-changed" };
    if (request.prompt.model) throw new HarnessError("harness_invalid_model_option", "Steering cannot change the active Claude model.");
    if (!this.processing(conversation) || !conversation.active) return { status: "rejected", inputId: request.inputId, code: "not-running" };
    const uuid = this.nativeClientInputId(id, request.inputId);
    const input = this.input(id, request.prompt, uuid, "now");
    if (conversation.active?.context?.clientId !== request.clientId && conversation.active?.context) {
      conversation.active.context = { ...conversation.active.context, clientId: undefined };
    }
    try {
      await conversation.native.send(input);
      return { status: "accepted", inputId: request.inputId, nativeMessageId: uuid, nativeClientInputId: uuid };
    } catch (error) {
      log.warn("Claude steering admission is unknown", { inputId: request.inputId, errorType: error instanceof Error ? error.name : typeof error });
      return { status: "unknown", inputId: request.inputId };
    }
  }

  private async reconcileInput(id: string, request: HarnessInputRecoveryRequest): Promise<HarnessInputAdmission> {
    const conversation = this.get(id);
    const nativeId = request.nativeMessageId ?? request.nativeClientInputId ?? this.nativeClientInputId(id, request.inputId);
    const delivered = conversation.receivedInputs.has(nativeId) || (await getSessionMessages(id, { dir: this.directory })).some((message) => message.type === "user" && message.uuid === nativeId);
    return delivered ? { status: "delivered", inputId: request.inputId, nativeMessageId: nativeId } : { status: "unknown", inputId: request.inputId };
  }

  private nativeClientInputId(sessionId: string, inputId: string): NonNullable<SDKUserMessage["uuid"]> {
    const hash = new Bun.CryptoHasher("sha1").update(new Uint8Array(16)).update(`clanky:claude:${sessionId}:${inputId}`).digest("hex");
    const variant = ((Number.parseInt(hash[16]!, 16) & 3) | 8).toString(16);
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  }

  private async settleOwnedWork(id: string): Promise<HarnessCleanupResult> {
    const conversation = this.get(id);
    if (conversation.faulted) return { status: "unavailable", reason: "gap" };
    if (this.processing(conversation)) await this.abortSession(id);
    for (const activity of conversation.translator.activities.values()) {
      if (activity.ownership === "owned" && ["running", "waiting", "queued", "stopping"].includes(activity.status)) await this.stopActivity(id, activity.id);
    }
    const pending = () => [
      ...(this.processing(conversation) ? [id] : []),
      ...[...conversation.translator.activities.values()].filter((activity) => !["stopped", "completed", "failed", "idle"].includes(activity.status)).map((activity) => activity.id),
    ];
    if (pending().length) await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); conversation.activityChanged.delete(changed); resolve(); };
      const changed = () => { if (conversation.faulted || !pending().length) finish(); };
      const timer = setTimeout(finish, 5_000);
      conversation.activityChanged.add(changed);
      changed();
    });
    if (conversation.faulted) return { status: "unavailable", reason: "gap" };
    const activityIds = pending();
    return activityIds.length ? { status: "pending", activityIds } : { status: "settled", observedAt: new Date().toISOString() };
  }

  private async *historySource(conversation: Conversation) {
    const translator = new ClaudeEventTranslator(conversation.info.id);
    const collector = new NativeSessionHistory();
    for (let offset = 0; ; offset += 200) {
      const messages = await getSessionMessages(conversation.info.id, { dir: this.directory, offset, limit: 200 });
      for (const message of messages) {
        for (const event of translator.history(message)) collector.append(event);
        const events = collector.takeEvents();
        if (events.length) yield events;
      }
      if (messages.length < 200) break;
    }
  }

  private async *childHistorySource(conversation: Conversation, activityId: string) {
    const translator = new ClaudeEventTranslator(conversation.info.id);
    const collector = new NativeSubagentHistory(activityId);
    let hasPrompt = false;
    for (let offset = 0; ; offset += 200) {
      const messages = await getSubagentMessages(conversation.info.id, activityId, { dir: this.directory, offset, limit: 200 });
      for (const message of messages) {
        for (const event of translator.history(message, activityId)) {
          hasPrompt ||= event.type === "user.message";
          collector.append(event);
        }
        const events = collector.takeEvents();
        if (events.length) yield events;
      }
      if (messages.length < 200) break;
    }
    if (!hasPrompt && !["running", "waiting", "queued", "stopping"].includes(conversation.translator.activities.get(activityId)?.status ?? "")) {
      throw new HarnessError("harness_event_gap", "The native Claude child transcript is not available yet.");
    }
  }

  private bindingPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HarnessError("harness_session_not_owned", "The native Claude identity is invalid.");
    const env = this.requireRuntime().env;
    return join(env["CLAUDE_CONFIG_DIR"] ?? join(env["HOME"] ?? homedir(), ".claude"), "clanky-bindings", `${id}.json`);
  }

  private async saveBinding(binding: HarnessConversationBinding): Promise<void> {
    const path = this.bindingPath(binding.nativeId);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${crypto.randomUUID()}`;
    await writeFile(temporary, JSON.stringify(binding), { mode: 0o600, flag: "wx" });
    try { await rename(temporary, path); } catch (error) {
      await unlink(temporary);
      throw error;
    }
  }

  private requireRuntime(): ClaudeRuntime {
    if (!this.runtime) throw new HarnessError("harness_transport_closed", "Claude is disconnected.");
    return this.runtime;
  }

  private processing(conversation: Conversation): boolean {
    return conversation.admitting || conversation.translator.processing
      || (conversation.native.state ?? conversation.initialState) !== "idle";
  }

  private get(id: string): Conversation {
    const conversation = this.conversations.get(id);
    if (!conversation || conversation.closing) throw new HarnessError("harness_session_not_found", "The Clanky-owned Claude conversation is unavailable.");
    return conversation;
  }

  private async closeSession(id: string): Promise<void> {
    const conversation = this.get(id);
    conversation.closing = true;
    this.endTurn(conversation);
    this.cancelQuestions(id);
    try { await conversation.native.close(); await conversation.pump; } finally {
      this.conversations.delete(id);
      this.events.closeSession(id);
    }
  }

  private operation(operation: () => Promise<AgentSession>): Promise<AgentSession> {
    this.requireRuntime();
    if (this.closing) throw new HarnessError("harness_transport_closed", "Claude sessions are closing.");
    if (this.conversations.size + this.operations.size >= 128) throw new HarnessError("harness_input_capacity", "Claude conversation capacity reached.");
    const pending = operation().finally(() => this.operations.delete(pending));
    this.operations.add(pending);
    return pending;
  }
}
