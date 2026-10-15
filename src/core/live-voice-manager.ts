/**
 * User-owned global Live call lifecycle, admission, leases and teardown.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { LiveVoiceCallState, LiveVoiceSessionResponse } from "@/shared/voice";
import type { LiveVoiceUiContext } from "@/shared/live-voice";
import { DomainError, isDomainError } from "../domain/domain-error";
import { requireCurrentUser, runWithCurrentUser } from "../context/user-context";
import { voiceManager } from "./voice-manager";
import { createLiveVoiceSession, type LiveVoiceCredentials } from "./live-voice-provider";
import { LiveVoiceCall } from "./live-voice-call";
import { LiveVoiceMemory } from "./live-voice-memory";
import type { ClankyOperationService, OperationAuthority } from "./clanky-operation-service";
import type { LiveVoiceAvailabilityResponse } from "@/contracts/schemas/voice";

const log = createLogger("core:live-voice-manager");
const LEASE_MS = 30_000;
const RETENTION_MS = 10 * 60_000;

export class LiveVoiceManager {
  private readonly calls = new Map<string, LiveVoiceCall>();
  private readonly memory = new LiveVoiceMemory();
  private readonly creating = new Map<string, Promise<void>>();
  private readonly shutdown = new AbortController();
  private readonly attempts = new Map<string, { times: number[]; retryAt: number }>();
  private maintenance?: ReturnType<typeof setInterval>;
  private readonly providerSessions = new Map<string, string>();
  private service?: ClankyOperationService;

  configure(service: ClankyOperationService): void { this.service = service; }

  getAvailability(): LiveVoiceAvailabilityResponse {
    return { supported: true };
  }

  async create(options: {
    sdp: string; clientId: string; context: LiveVoiceUiContext;
    authority: OperationAuthority; signal: AbortSignal;
  }): Promise<LiveVoiceSessionResponse> {
    const { sdp, clientId, context, authority } = options;
    let { signal } = options;
    signal = AbortSignal.any([signal, this.shutdown.signal]);
    if (signal.aborted) throw new DomainError("voice_provider_unreachable", "Live sessions are shutting down.");
    const user = requireCurrentUser();
    const owner = user.id;
    if (this.creating.has(owner) || [...this.calls.values()].some((call) =>
      call.scope.user.id === user.id && !["closed", "failed"].includes(call.state.status),
    )) throw new DomainError("voice_live_busy", "You already have a Live call in another tab.");
    if (this.creating.size + [...this.calls.values()].filter((call) => !["closed", "failed"].includes(call.state.status)).length >= 8) {
      throw new DomainError("voice_live_busy", "Live call capacity is in use.");
    }
    const startup = Promise.withResolvers<void>();
    this.creating.set(owner, startup.promise);
    let call: LiveVoiceCall | undefined;
    try {
      if (!this.service) throw new DomainError("voice_live_unavailable", "The global operation service is unavailable.");
      const credentials = await voiceManager.requireLiveCredentials();
      const limiter = this.admit(credentials);
      const history = this.memory.get(owner);
      const started = await createLiveVoiceSession(credentials, sdp, { signal, history }).catch((error: unknown) => {
        if (isDomainError(error) && error.code === "voice_provider_rate_limited") {
          const retryAfter = String(error.details["retryAfter"] ?? "");
          const seconds = Number(retryAfter);
          const date = Date.parse(retryAfter);
          limiter.retryAt = retryAfter && Number.isFinite(seconds)
            ? Date.now() + Math.max(1, seconds) * 1_000
            : Number.isFinite(date) ? Math.max(Date.now() + 1_000, date) : Date.now() + 60_000;
        }
        throw error;
      });
      const id = crypto.randomUUID();
      call = new LiveVoiceCall({ id, clientId, user, credentials, authority, context, service: this.service }, () => {
        // A provider close/error is a long-lived session event. Finalization
        // reports its own failures, independent of HTTP.
        void runWithCurrentUser(user, () => this.close(id, clientId)).catch(() => {
          log.error("Live call finalization failed", { callId: id });
        });
      }, history);
      this.calls.set(id, call);
      this.providerSessions.set(id, started.id);
      await call.connection.connect(credentials, started.id, signal);
      if (call.state.error || signal.aborted) throw new DomainError("voice_provider_unreachable", "Live sideband could not be established.");
      call.state.status = "active";
      call.sendContext();
      call.started = true;
      this.startMaintenance();
      log.info("Global Live call started", { callId: id, clientId });
      return { call: { ...call.state }, sdp: started.sdp };
    } catch (error) {
      if (call) {
        if (!call.connection.connected) {
          call.connection.dispose();
          // One bounded cleanup attachment can close a provider session whose
          // initial sideband failed. This does not create another session.
          try {
            await call.connection.connect(call.scope.credentials, this.providerSessions.get(call.scope.id)!, AbortSignal.timeout(10_000));
          } catch {
            log.error("Created Live session could not be attached for cleanup", { callId: call.scope.id });
          }
        }
        call.closePromise ??= this.finalize(call);
        await call.closePromise;
        this.calls.delete(call.scope.id);
      } else authority.release();
      throw error;
    } finally {
      this.creating.delete(owner);
      startup.resolve();
    }
  }

  heartbeat(id: string, clientId: string, context: LiveVoiceUiContext, authority: OperationAuthority): LiveVoiceCallState {
    let call: LiveVoiceCall;
    try { call = this.requireCall(id, clientId); } catch (error) { authority.release(); throw error; }
    call.scope.authority.refresh(authority);
    call.lastHeartbeat = Date.now();
    const revision = call.actions.uiContext.revision;
    call.actions.updateContext(context);
    if (call.state.status === "active" && call.actions.uiContext.revision > revision) call.sendContext();
    return { ...call.state };
  }

  getState(id: string): LiveVoiceCallState { return { ...this.requireCall(id).state }; }

  refreshAuthority(id: string, clientId: string, authority: OperationAuthority): void {
    try { this.requireCall(id, clientId).scope.authority.refresh(authority); }
    catch (error) { authority.release(); throw error; }
  }

  async confirm(id: string, clientId: string, requestId: string, approved: boolean) {
    return await this.requireCall(id, clientId).confirm(requestId, approved);
  }

  supplyCredential(id: string, clientId: string, requestId: string, token: string | null): void {
    this.requireCall(id, clientId).actions.supplyCredential(requestId, token);
  }

  async close(id: string, clientId: string): Promise<LiveVoiceCallState> {
    const call = this.requireCall(id, clientId);
    if (call.closePromise) return await call.closePromise;
    if (["closed", "failed"].includes(call.state.status)) return { ...call.state };
    call.closePromise = this.finalize(call);
    return await call.closePromise;
  }

  private requireCall(id: string, clientId?: string): LiveVoiceCall {
    const call = this.calls.get(id);
    if (!call || call.scope.user.id !== requireCurrentUser().id || clientId !== undefined && call.scope.clientId !== clientId) {
      throw new DomainError("voice_live_not_found", "The Live call is unavailable.");
    }
    return call;
  }

  private admit(credentials: LiveVoiceCredentials) {
    const key = new Bun.CryptoHasher("sha256").update(`${credentials.baseUrl}:${credentials.apiKey}`).digest("hex");
    const now = Date.now();
    for (const [id, entry] of this.attempts) {
      entry.times = entry.times.filter((time) => now - time < 60_000);
      if (!entry.times.length && entry.retryAt <= now) this.attempts.delete(id);
    }
    if (!this.attempts.has(key) && this.attempts.size >= 128) throw new DomainError("voice_live_busy", "Live connection capacity is in use.");
    const entry = this.attempts.get(key) ?? { times: [], retryAt: 0 };
    const retryAt = Math.max(entry.retryAt, entry.times.length >= 10 ? entry.times[0]! + 60_000 : 0);
    if (retryAt > now) {
      throw new DomainError("voice_provider_rate_limited", "Wait before opening another Live call.", {
        details: { retryAfter: String(Math.ceil((retryAt - now) / 1_000)) },
      });
    }
    entry.times.push(now);
    this.attempts.set(key, entry);
    return entry;
  }

  private async finalize(call: LiveVoiceCall): Promise<LiveVoiceCallState> {
    const remember = call.started;
    call.state.status = "closing";
    call.stopActions();
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...call.operations]),
        new Promise<never>((_resolve, reject) => {
          drainTimer = setTimeout(() => reject(new Error("Live actions did not drain.")), 10_000);
        }),
      ]);
    } catch {
      call.state.error ??= "An action is still settling. Inspect its target before repeating it.";
    } finally {
      clearTimeout(drainTimer);
    }
    try {
      const finalized = await call.connection.close();
      if (!finalized) call.state.error ??= "The connection ended without confirmed Live finalization.";
    } catch {
      call.state.error ??= "The Live connection could not be closed cleanly.";
      call.connection.dispose();
    }
    {
      call.state.status = call.state.error ? "failed" : "closed";
      call.state.processing = false;
      call.state.intention = null;
      call.lastHeartbeat = Date.now();
      if (remember) {
        if (call.state.error) call.conversation.rememberInterruption();
        this.memory.retain(call.scope.user.id, call.conversation.takeHistory());
      }
      call.release();
      this.providerSessions.delete(call.scope.id);
      const retained = [...this.calls.values()].filter((entry) => ["closed", "failed"].includes(entry.state.status));
      for (const entry of retained.slice(0, Math.max(0, retained.length - 64))) this.calls.delete(entry.scope.id);
      log.info("Global Live call ended", { callId: call.scope.id });
    }
    return { ...call.state };
  }

  private startMaintenance(): void {
    if (this.maintenance) return;
    this.maintenance = setInterval(() => {
      this.memory.prune();
      for (const [id, call] of this.calls) {
        const age = Date.now() - call.lastHeartbeat;
        if (["closed", "failed"].includes(call.state.status)) {
          if (age > RETENTION_MS) this.calls.delete(id);
        } else if (age > LEASE_MS && !call.closePromise) {
          void runWithCurrentUser(call.scope.user, () => this.close(id, call.scope.clientId)).catch(() => {
            log.error("Expired Live call cleanup failed", { callId: id });
          });
        }
      }
      if (!this.calls.size && !this.creating.size && !this.memory.hasEntries) { clearInterval(this.maintenance); this.maintenance = undefined; }
    }, 5_000);
    this.maintenance.unref();
  }

  async closeAll(): Promise<void> {
    this.shutdown.abort();
    await Promise.all([...this.creating.values()]);
    await Promise.all([...this.calls.values()].map((call) =>
      runWithCurrentUser(call.scope.user, () => this.close(call.scope.id, call.scope.clientId)),
    ));
    clearInterval(this.maintenance);
    this.maintenance = undefined;
    this.calls.clear();
    this.memory.clear();
  }
}

export const liveVoiceManager = new LiveVoiceManager();
