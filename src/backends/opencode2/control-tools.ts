/**
 * Owns the host-local tool bridge, root bindings and cancellable Control turns.
 */

import type { OpenCodeClient } from "@opencode/client";
import { createLogger, resolveAppDataDir } from "@pablozaiden/webapp/server";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ClankyControlContext } from "@/shared/clanky-control";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import { CLANKY_CONTROL_TOOLS, ClankyControlToolService } from "../clanky-control-tools";
import { HarnessError } from "../harness-errors";
import { OPENCODE_CONTROL_PLUGIN_ID, OPENCODE_CONTROL_PLUGIN_SOURCE } from "./control-plugin";

const log = createLogger("opencode2-control-tools");
const SessionInputSchema = z.object({ sessionId: z.string().min(1).max(500) }).strict();
const InvocationSchema = SessionInputSchema.extend({
  name: z.string().min(1).max(500),
  input: z.unknown(),
}).strict();
const ConfigSchema = z.object({
  plugins: z.array(z.union([
    z.string(),
    z.object({ package: z.string(), options: z.record(z.string(), z.unknown()).optional() }),
  ])).optional(),
}).passthrough();

interface ControlConversation {
  binding: HarnessConversationBinding;
  active?: { context: ClankyControlContext; abort: AbortController };
}

export class OpenCodeControlTools {
  private readonly conversations = new Map<string, ControlConversation>();
  private readonly pending = new Set<Promise<Response>>();
  private server?: Bun.Server<undefined>;
  private toolService?: ClankyControlToolService;
  private pluginDirectory?: string;
  private closing?: Promise<void>;

  constructor(private readonly managedEnvironment: Record<string, string | undefined>) {}

  async open(environment: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const profile = join(resolveAppDataDir({ envPrefix: "CLANKY", appDirectoryName: ".clanky" }), "native", "opencode2");
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await this.removeAbandonedPlugins(profile);
    this.pluginDirectory = await mkdtemp(join(profile, `control-${process.pid}-`));
    try {
      const rawConfig = environment["OPENCODE_CONFIG_CONTENT"] ?? process.env["OPENCODE_CONFIG_CONTENT"];
      const config = ConfigSchema.parse(rawConfig ? Bun.JSON5.parse(rawConfig) : {});
      await Promise.all([
        Bun.write(join(this.pluginDirectory, "package.json"), JSON.stringify({ type: "module", main: "index.js" })),
        Bun.write(join(this.pluginDirectory, "index.js"), OPENCODE_CONTROL_PLUGIN_SOURCE),
      ]);
      const token = crypto.randomUUID();
      this.server = Bun.serve<undefined>({
        hostname: "127.0.0.1",
        port: 0,
        maxRequestBodySize: 1024 * 1024,
        fetch: (request) => {
          if (request.headers.get("authorization") !== `Bearer ${token}`) {
            return new Response(null, { status: 401 });
          }
          if (this.closing) return new Response(null, { status: 503 });
          if (this.pending.size >= 128) return new Response(null, { status: 429 });
          const operation = this.handle(request).catch((error: unknown) => {
            log.error("Native Control bridge request failed", { error: String(error) });
            return Response.json({ error: "control_bridge_failed" }, { status: 500 });
          }).finally(() => { this.pending.delete(operation); });
          this.pending.add(operation);
          return operation;
        },
      });
      return {
        ...environment,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugins: [...(config.plugins ?? []), this.pluginDirectory] }),
        CLANKY_OPENCODE_CONTROL_URL: this.server.url.origin,
        CLANKY_OPENCODE_CONTROL_TOKEN: token,
      };
    } catch (error) {
      try { await this.close(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "OpenCode Control bridge startup and cleanup failed.");
      }
      throw new HarnessError("harness_runtime_unavailable", "OpenCode Control plugin configuration is unavailable.", { cause: error });
    }
  }

  async requireAvailable(client: OpenCodeClient, directory: string): Promise<void> {
    if (this.closing || !this.server) throw new HarnessError("harness_transport_closed", "OpenCode Control is disconnected.");
    this.getToolService();
    // Inventory alone does not wait for a cold location's plugin activation.
    await client.integration.list({ location: { directory } });
    const plugins = await client.plugin.list({ location: { directory } });
    const plugin = plugins.data.find((entry) => entry.source.type === "local"
      && (entry.source.path === this.pluginDirectory || entry.source.path === join(this.pluginDirectory!, "index.js")));
    if (plugin?.id !== OPENCODE_CONTROL_PLUGIN_ID || plugin.state.status !== "active") {
      if (plugin?.state.status === "failed") {
        log.error("Managed native Control plugin activation failed", { error: plugin.state.error });
      }
      throw new HarnessError("harness_unsupported_feature", "The native OpenCode Clanky Control plugin is unavailable.");
    }
  }

  register(binding: HarnessConversationBinding): void {
    this.end(binding.nativeId);
    if (binding.controlTools) {
      if (!this.conversations.has(binding.nativeId) && this.conversations.size >= 128) {
        throw new HarnessError("harness_request_failed", "OpenCode Control conversation capacity reached.");
      }
      this.conversations.set(binding.nativeId, { binding });
    } else {
      this.conversations.delete(binding.nativeId);
    }
  }

  begin(id: string, context: ClankyControlContext | undefined): void {
    const conversation = this.conversations.get(id);
    if (!conversation) {
      if (context) throw new HarnessError("harness_session_not_owned", "Clanky control context is not enabled for this conversation.");
      return;
    }
    if (
      !context || context.chatId !== (conversation.binding.controlChatId ?? conversation.binding.contextId)
      || !context.workspaceId || !context.turnId
    ) throw new HarnessError("harness_session_not_owned", "The active Clanky control turn does not match its native conversation.");
    if (conversation.active) throw new HarnessError("harness_request_failed", "A Clanky control turn is already active in this conversation.");
    conversation.active = { context, abort: new AbortController() };
  }

  prepareSteering(id: string, clientId: string | undefined): void {
    const active = this.conversations.get(id)?.active;
    if (active?.context.clientId && active.context.clientId !== clientId) {
      active.context = { ...active.context, clientId: undefined };
    }
  }

  end(id: string): void {
    const conversation = this.conversations.get(id);
    conversation?.active?.abort.abort();
    if (conversation) conversation.active = undefined;
  }

  forget(id: string): void {
    this.end(id);
    this.conversations.delete(id);
  }

  cancelAll(): void {
    for (const id of this.conversations.keys()) this.end(id);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      const errors: unknown[] = [];
      this.cancelAll();
      try { await this.server?.stop(true); } catch (error) { errors.push(error); }
      await Promise.allSettled(this.pending);
      this.conversations.clear();
      this.toolService = undefined;
      if (this.pluginDirectory) {
        try { await rm(this.pluginDirectory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
      }
      this.server = undefined;
      if (errors.length) throw new AggregateError(errors, "OpenCode Control bridge cleanup failed.");
    })();
    return this.closing;
  }

  private getToolService(): ClankyControlToolService {
    if (!this.toolService) {
      try {
        this.toolService = new ClankyControlToolService(this.managedEnvironment);
      } catch (error) {
        throw new HarnessError("harness_runtime_unavailable", "Managed Clanky API credentials are unavailable for control tools.", { cause: error });
      }
    }
    return this.toolService;
  }

  private async removeAbandonedPlugins(profile: string): Promise<void> {
    // Abrupt server termination cannot run asynchronous connection cleanup.
    for (const entry of await readdir(profile, { withFileTypes: true })) {
      const match = /^control-([1-9][0-9]*)-[A-Za-z0-9]+$/.exec(entry.name);
      if (!entry.isDirectory() || !match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid > 2_147_483_647 || pid === process.pid) continue;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EPERM") continue;
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        await rm(join(profile, entry.name), { recursive: true, force: true });
      }
    }
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/tools" && request.method === "GET") {
      return Response.json(CLANKY_CONTROL_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
    }
    if ((path !== "/context" && path !== "/invoke") || request.method !== "POST") {
      return new Response(null, { status: 404 });
    }
    let input: unknown;
    try { input = await request.json(); } catch {
      return Response.json({ error: "invalid_bridge_input" }, { status: 400 });
    }
    const parsed = (path === "/invoke" ? InvocationSchema : SessionInputSchema).safeParse(input);
    if (!parsed.success) return Response.json({ error: "invalid_bridge_input" }, { status: 400 });
    const active = this.conversations.get(parsed.data.sessionId)?.active;
    if (path === "/context") return Response.json({ enabled: active !== undefined });
    if (!active) return Response.json({
      ok: false,
      error: { code: "control_context_unavailable", message: "The control tool call is not correlated with an active chat turn." },
    });
    const invocation = InvocationSchema.parse(input);
    const result = await this.getToolService().invoke(invocation.name, invocation.input, active.context,
      AbortSignal.any([request.signal, active.abort.signal]));
    return Response.json(result);
  }
}
