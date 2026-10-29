/**
 * Owns Clanky's managed webapp API-key generations for execution contexts.
 *
 * The service stores only key metadata in Clanky's database. Plaintext tokens
 * remain in this bounded process-memory cache for runtime launch/reconnect.
 */

import {
  createManagedApiKey,
  listManagedApiKeys,
  revokeManagedApiKey,
  type ManagedApiKeySummary,
  type RuntimeConfig,
  type WebAppStore,
} from "@pablozaiden/webapp/server";
import {
  CLANKY_CONTROL_SCOPE,
  CLANKY_CONTROL_GENERAL_SCOPE,
  CLANKY_CONTROL_MANAGED_SCOPE,
  controlWorkspaceScope,
  type ManagedContextIdentity,
} from "@/shared/context-api-key";
import { isAgentRunActiveStatus } from "@/shared/agent";
import {
  createContextApiKeyAssociationForUser,
  getContextApiKeyAssociationForUser,
  getNextContextApiKeyGenerationForUser,
  listContextApiKeyAssociationsForUser,
  listContextApiKeyAssociationsForContextForUser,
  revokeContextApiKeyAssociationForUser,
  type ContextApiKeyAssociation,
} from "../persistence/context-api-keys";
import { loadAgentRunSummary } from "../persistence/agents";
import { loadChatMetadata } from "../persistence/chats";
import { loadTaskSummary } from "../persistence/tasks";
import { getTerminalSession } from "../persistence/terminal-sessions";
import { getWorkspace } from "../persistence/workspaces";
import { DomainError } from "../domain/domain-error";
import { requireExecutionOwnerUser } from "../context/user-context";

const MANAGED_BY = "clanky.execution-context";
export const DETERMINISTIC_AGENT_MANAGED_BY = "clanky.deterministic-agent-runtime";
export const CLANKY_CONTROL_CHAT_MANAGED_BY = "clanky.control-chat";
export const DETERMINISTIC_AGENT_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED_CREDENTIALS = 256;
const CONTROL_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;

function isControlCredential(options?: ManagedCredentialOptions): boolean {
  return options?.control === true
    || options?.managedBy === DETERMINISTIC_AGENT_MANAGED_BY
    || options?.managedBy === CLANKY_CONTROL_CHAT_MANAGED_BY;
}

function canCreateWhenWorkspaceDisabled(options?: ManagedCredentialOptions): boolean {
  return options?.allowWhenWorkspaceDisabled === true
    && (
      options.managedBy === DETERMINISTIC_AGENT_MANAGED_BY
      || options.managedBy === CLANKY_CONTROL_CHAT_MANAGED_BY
    );
}

export type ManagedCredentialMode = "reuse" | "recreate";

export interface ManagedCredentialOptions {
  control?: boolean;
  managedBy?: string;
  name?: string;
  scopes?: string[];
  expiresAt?: string;
  /**
   * Allow a narrowly scoped runtime credential to be created even when the
   * workspace does not expose general Clanky CLI credentials.
   */
  allowWhenWorkspaceDisabled?: boolean;
  /** Reuse a cached key when the requested runtime-specific options are compatible. */
  reuseActiveCredential?: boolean;
}

export type ManagedCredentialErrorCode =
  | "managed_context_not_configured"
  | "managed_context_base_url_missing"
  | "managed_context_base_url_invalid"
  | "managed_context_disabled"
  | "managed_context_owner_mismatch"
  | "managed_context_scope_invalid"
  | "managed_context_setup_failed"
  | "managed_context_revocation_failed";

export class ManagedCredentialError extends DomainError<ManagedCredentialErrorCode> {}

export interface ManagedRuntimeCredential extends ManagedContextIdentity {
  apiKeyId: string;
  generation: number;
  baseUrl: string;
  token: string;
  scopes: readonly string[];
  expiresAt?: string;
  managedBy?: string;
}

function credentialCacheKey(identity: ManagedContextIdentity): string {
  return JSON.stringify([
    identity.userId,
    identity.workspaceId,
    identity.contextType,
    identity.contextId,
  ]);
}

function contextDetails(identity: ManagedContextIdentity): Record<string, string> {
  return {
    workspaceId: identity.workspaceId,
    contextType: identity.contextType,
    contextId: identity.contextId,
  };
}

export class ManagedCredentialService {
  private store: WebAppStore | undefined;
  private publicBaseUrl: string | undefined;
  private localBaseUrl: string | undefined;
  private readonly activeCredentials = new Map<string, ManagedRuntimeCredential>();
  private readonly credentialLocks = new Map<string, Promise<void>>();

  configure(
    store: WebAppStore,
    config: Pick<RuntimeConfig, "publicBaseUrl"> & { localBaseUrl?: string },
  ): void {
    this.store = store;
    this.publicBaseUrl = config.publicBaseUrl;
    this.localBaseUrl = config.localBaseUrl;
    this.activeCredentials.clear();
    this.credentialLocks.clear();
  }

  async ensureCredential(
    identity: ManagedContextIdentity,
    mode: ManagedCredentialMode = "reuse",
    options?: ManagedCredentialOptions,
  ): Promise<ManagedRuntimeCredential> {
    const user = requireExecutionOwnerUser();
    this.assertOwner(identity, user.id);
    if (identity.contextType !== "terminal_session" && !isControlCredential(options)) {
      throw new ManagedCredentialError(
        "managed_context_disabled",
        "Automatic Clanky credentials are unavailable for this execution adapter",
        { details: contextDetails(identity) },
      );
    }
    return await this.withCredentialLock(identity, async () => {
      const store = this.requireStore();
      const cacheKey = credentialCacheKey(identity);
      const associations = await listContextApiKeyAssociationsForContextForUser(
        user.id,
        identity.workspaceId,
        identity.contextType,
        identity.contextId,
      );

      const control = isControlCredential(options);
      const workspace = await getWorkspace(identity.workspaceId);
      if (control && identity.contextType === "terminal_session") {
        throw new ManagedCredentialError("managed_context_scope_invalid", "A terminal session is not an application-control execution.");
      }
      if (control || associations.length === 0) {
        if (!workspace) {
          throw new ManagedCredentialError("managed_context_not_configured", "Managed context workspace was not found", {
            details: contextDetails(identity),
          });
        }
        if (!control && workspace.allowClankyContext !== true && !canCreateWhenWorkspaceDisabled(options)) {
          throw new ManagedCredentialError(
            "managed_context_disabled",
            "This workspace does not allow new Clanky execution contexts",
            { details: contextDetails(identity) },
          );
        }
      }

      if (control && options?.scopes?.some((scope) => scope === "*" || scope.startsWith(CLANKY_CONTROL_SCOPE))) {
        throw new ManagedCredentialError("managed_context_scope_invalid", "Application-control grants must be derived from the execution, not supplied scopes.");
      }
      const scopes = control ? [...new Set([
        CLANKY_CONTROL_SCOPE, CLANKY_CONTROL_MANAGED_SCOPE, controlWorkspaceScope(identity.workspaceId),
        ...(workspace?.allowClankyContext === true ? [CLANKY_CONTROL_GENERAL_SCOPE] : []),
        ...(options?.scopes ?? []),
      ])] : options?.scopes ?? ["*"];
      const managedBy = options?.managedBy ?? (control ? "clanky.control-runtime" : MANAGED_BY);
      const activeKeys = listManagedApiKeys(store, user.id);
      if (mode === "reuse" && (control ? options?.reuseActiveCredential !== false : !options || options.reuseActiveCredential === true)) {
        const cached = this.activeCredentials.get(cacheKey);
        if (cached && cached.managedBy === managedBy
          && cached.scopes.length === scopes.length && scopes.every((scope) => cached.scopes.includes(scope))
          && activeKeys.some((key) => key.id === cached.apiKeyId)
          && (!cached.expiresAt || Date.parse(cached.expiresAt) > Date.now())
          && (!options?.expiresAt || cached.expiresAt
            && Date.parse(cached.expiresAt) <= Date.parse(options.expiresAt))) {
          const baseUrl = await this.requirePublicBaseUrl(identity, control);
          this.activeCredentials.delete(cacheKey);
          this.activeCredentials.set(cacheKey, { ...cached, baseUrl });
          return { ...cached, baseUrl };
        }
      }

      const baseUrl = await this.requirePublicBaseUrl(identity, control);
      const generation = await getNextContextApiKeyGenerationForUser(
        user.id,
        identity.workspaceId,
        identity.contextType,
        identity.contextId,
      );
      if (control) {
        for (const association of associations) {
          if (association.revokedAt || !activeKeys.some((key) => key.id === association.apiKeyId && key.scopes.includes("*"))) continue;
          revokeManagedApiKey(store, association.apiKeyId, user.id);
          await revokeContextApiKeyAssociationForUser(user.id, association.apiKeyId);
        }
      }
      let expiresAt = options?.expiresAt;
      if (control) {
        const requestedExpiry = expiresAt ? Date.parse(expiresAt) : Date.now() + CONTROL_CREDENTIAL_TTL_MS;
        if (!Number.isFinite(requestedExpiry) || requestedExpiry <= Date.now()) {
          throw new ManagedCredentialError("managed_context_scope_invalid", "A control credential must have a valid future expiration.");
        }
        expiresAt = new Date(Math.min(requestedExpiry, Date.now() + CONTROL_CREDENTIAL_TTL_MS)).toISOString();
      }
      const created = createManagedApiKey(store, user, {
        name: options?.name ?? "Clanky execution context",
        managedBy,
        scopes,
        expiresAt,
      });

      let association: ContextApiKeyAssociation;
      try {
        association = await createContextApiKeyAssociationForUser(user.id, {
          workspaceId: identity.workspaceId,
          contextType: identity.contextType,
          contextId: identity.contextId,
          apiKeyId: created.key.id,
          generation,
        });
      } catch (error) {
        try {
          revokeManagedApiKey(store, created.key.id, user.id);
        } catch (cleanupError) {
          throw new ManagedCredentialError(
            "managed_context_setup_failed",
            "Failed to persist a managed execution credential and clean it up",
            {
              cause: new AggregateError([error, cleanupError], "Managed credential setup cleanup failed"),
              details: contextDetails(identity),
            },
          );
        }
        throw new ManagedCredentialError(
          "managed_context_setup_failed",
          "Failed to persist a managed execution credential",
          { cause: error, details: contextDetails(identity) },
        );
      }

      const credential: ManagedRuntimeCredential = {
        ...identity,
        apiKeyId: association.apiKeyId,
        generation: association.generation,
        baseUrl,
        token: created.token,
        scopes: Object.freeze([...created.key.scopes]),
        ...(created.key.expiresAt ? { expiresAt: created.key.expiresAt } : {}),
        ...(created.key.managedBy ? { managedBy: created.key.managedBy } : {}),
      };
      this.cacheCredential(cacheKey, credential);
      return credential;
    });
  }

  async ensureCredentialForRuntime(
    identity: ManagedContextIdentity,
    mode: ManagedCredentialMode = "reuse",
    options?: ManagedCredentialOptions,
  ): Promise<ManagedRuntimeCredential | undefined> {
    const user = requireExecutionOwnerUser();
    this.assertOwner(identity, user.id);
    if (isControlCredential(options)) return await this.ensureCredential(identity, mode, options);
    if (identity.contextType !== "terminal_session") return undefined;
    const associations = await listContextApiKeyAssociationsForContextForUser(
      user.id,
      identity.workspaceId,
      identity.contextType,
      identity.contextId,
    );
    if (associations.length === 0) {
      const workspace = await getWorkspace(identity.workspaceId);
      if (!workspace) {
        throw new ManagedCredentialError("managed_context_not_configured", "Managed context workspace was not found", {
          details: contextDetails(identity),
        });
      }
      if (workspace.allowClankyContext !== true && !canCreateWhenWorkspaceDisabled(options)) {
        return undefined;
      }
    }

    return await this.ensureCredential(identity, mode, options);
  }

  async resolveControlContext(apiKeyId: string): Promise<ManagedContextIdentity | undefined> {
    const user = requireExecutionOwnerUser();
    const association = await getContextApiKeyAssociationForUser(user.id, apiKeyId);
    if (!association) return undefined;
    const key = listManagedApiKeys(this.requireStore(), user.id).find((candidate) => candidate.id === apiKeyId);
    if (association.revokedAt || !key || !key.scopes.includes(CLANKY_CONTROL_MANAGED_SCOPE)
      || association.contextType === "terminal_session" || !await this.contextExists(association)) {
      throw new DomainError("control_context_unavailable", "The managed control execution has ended or its credential was revoked.");
    }
    return {
      userId: user.id, workspaceId: association.workspaceId,
      contextType: association.contextType, contextId: association.contextId,
    };
  }

  async revokeCredential(credential: ManagedRuntimeCredential): Promise<void> {
    const user = requireExecutionOwnerUser();
    this.assertOwner(credential, user.id);
    await this.withCredentialLock(credential, async () => {
      const store = this.requireStore();
      try {
        revokeManagedApiKey(store, credential.apiKeyId, user.id);
        await revokeContextApiKeyAssociationForUser(user.id, credential.apiKeyId);
      } catch (error) {
        throw new ManagedCredentialError(
          "managed_context_revocation_failed",
          "Failed to revoke a managed execution credential",
          {
            cause: error,
            details: contextDetails(credential),
          },
        );
      }
      this.removeCachedCredential(credential);
    });
  }

  async revokeContext(identity: ManagedContextIdentity): Promise<void> {
    const user = requireExecutionOwnerUser();
    this.assertOwner(identity, user.id);
    await this.withCredentialLock(identity, async () => {
      const store = this.requireStore();
      const associations = await listContextApiKeyAssociationsForContextForUser(
        user.id,
        identity.workspaceId,
        identity.contextType,
        identity.contextId,
      );
      let firstError: unknown;

      for (const association of associations) {
        try {
          revokeManagedApiKey(store, association.apiKeyId, user.id);
          await revokeContextApiKeyAssociationForUser(user.id, association.apiKeyId);
        } catch (error) {
          firstError ??= error;
        }
      }
      this.activeCredentials.delete(credentialCacheKey(identity));
      if (firstError !== undefined) {
        throw new ManagedCredentialError(
          "managed_context_revocation_failed",
          "Failed to revoke one or more managed execution credentials",
          { cause: firstError, details: contextDetails(identity) },
        );
      }
    });
  }

  async revokeContextIfConfigured(identity: ManagedContextIdentity): Promise<void> {
    if (!this.store) {
      return;
    }
    await this.revokeContext(identity);
  }

  async revokeWorkspace(workspaceId: string): Promise<void> {
    if (!this.store) {
      return;
    }
    const user = requireExecutionOwnerUser();
    const associations = await listContextApiKeyAssociationsForUser(user.id);
    const contextKeys = new Set<string>();
    for (const association of associations) {
      if (association.workspaceId !== workspaceId) {
        continue;
      }
      const contextKey = JSON.stringify([
        association.workspaceId,
        association.contextType,
        association.contextId,
      ]);
      if (contextKeys.has(contextKey)) {
        continue;
      }
      contextKeys.add(contextKey);
      await this.revokeContext({
        userId: user.id,
        workspaceId: association.workspaceId,
        contextType: association.contextType,
        contextId: association.contextId,
      });
    }
  }

  async reconcileCurrentUser(): Promise<number> {
    if (!this.store) {
      return 0;
    }
    const user = requireExecutionOwnerUser();
    const associations = await listContextApiKeyAssociationsForUser(user.id);
    const managedKeys = listManagedApiKeys(this.store, user.id);
    const managedKeysById = new Map(managedKeys.map((key) => [key.id, key]));
    const activeAssociationKeyIds = new Set<string>();
    const contextKeys = new Set<string>();
    let revokedContextCount = 0;
    for (const association of associations) {
      if (association.revokedAt) {
        continue;
      }
      const key = managedKeysById.get(association.apiKeyId);
      if (!key) {
        await revokeContextApiKeyAssociationForUser(user.id, association.apiKeyId);
        revokedContextCount += 1;
        continue;
      }
      activeAssociationKeyIds.add(association.apiKeyId);
      if (key.managedBy === DETERMINISTIC_AGENT_MANAGED_BY
        || association.contextType !== "terminal_session" && key.scopes.includes("*")) {
        revokeManagedApiKey(this.store, association.apiKeyId, user.id);
        await revokeContextApiKeyAssociationForUser(user.id, association.apiKeyId);
        revokedContextCount += 1;
        continue;
      }
      const contextKey = JSON.stringify([
        association.workspaceId,
        association.contextType,
        association.contextId,
      ]);
      if (contextKeys.has(contextKey)) {
        continue;
      }
      contextKeys.add(contextKey);
      if (await this.contextExists(association)) {
        continue;
      }
      await this.revokeContext({
        userId: user.id,
        workspaceId: association.workspaceId,
        contextType: association.contextType,
        contextId: association.contextId,
      });
      revokedContextCount += 1;
    }
    for (const managedKey of managedKeys) {
      if (
        managedKey.managedBy === DETERMINISTIC_AGENT_MANAGED_BY
        && !activeAssociationKeyIds.has(managedKey.id)
      ) {
        revokeManagedApiKey(this.store, managedKey.id, user.id);
        revokedContextCount += 1;
      }
    }
    return revokedContextCount;
  }

  async cleanupFailedLaunch(
    credential: ManagedRuntimeCredential | undefined,
    launchError: unknown,
  ): Promise<never> {
    if (!credential) {
      throw launchError;
    }
    try {
      await this.revokeCredential(credential);
    } catch (cleanupError) {
      throw new ManagedCredentialError(
        "managed_context_setup_failed",
        "Managed runtime launch failed and its credential could not be revoked",
        {
          cause: new AggregateError([launchError, cleanupError], "Managed runtime launch cleanup failed"),
          details: contextDetails(credential),
        },
      );
    }
    throw launchError;
  }

  listManagedKeysForCurrentUser(managedBy?: string): ManagedApiKeySummary[] {
    const user = requireExecutionOwnerUser();
    return listManagedApiKeys(this.requireStore(), user.id, managedBy ?? MANAGED_BY);
  }

  private assertOwner(identity: ManagedContextIdentity, userId: string): void {
    if (identity.userId !== userId) {
      throw new ManagedCredentialError(
        "managed_context_owner_mismatch",
        "Managed execution context belongs to another user",
        { details: contextDetails(identity) },
      );
    }
  }

  private requireStore(): WebAppStore {
    if (!this.store) {
      throw new ManagedCredentialError(
        "managed_context_not_configured",
        "Managed execution credentials are not configured",
      );
    }
    return this.store;
  }

  private async requirePublicBaseUrl(identity: ManagedContextIdentity, control = false): Promise<string> {
    let rawValue = this.publicBaseUrl?.trim();
    if (!rawValue) {
      const workspace = await getWorkspace(identity.workspaceId);
      if (control || workspace?.executionHostBinding.host.kind === "local") {
        rawValue = this.localBaseUrl?.trim();
      }
    }
    if (!rawValue) {
      throw new ManagedCredentialError(
        "managed_context_base_url_missing",
        "A reachable Clanky public base URL must be configured before starting a managed execution context on a remote workspace",
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(rawValue);
    } catch (error) {
      throw new ManagedCredentialError(
        "managed_context_base_url_invalid",
        "CLANKY_PUBLIC_BASE_URL must be an absolute HTTP(S) origin",
        { cause: error },
      );
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      throw new ManagedCredentialError(
        "managed_context_base_url_invalid",
        "CLANKY_PUBLIC_BASE_URL must be an absolute HTTP(S) origin",
      );
    }
    return parsed.origin;
  }

  private cacheCredential(cacheKey: string, credential: ManagedRuntimeCredential): void {
    this.activeCredentials.delete(cacheKey);
    this.activeCredentials.set(cacheKey, credential);
    while (this.activeCredentials.size > MAX_CACHED_CREDENTIALS) {
      const oldest = this.activeCredentials.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }

      this.activeCredentials.delete(oldest);
    }
  }

  private async withCredentialLock<T>(
    identity: ManagedContextIdentity,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockKey = credentialCacheKey(identity);
    const previous = this.credentialLocks.get(lockKey);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.credentialLocks.set(lockKey, current);
    if (previous) {
      await previous;
    }
    try {
      return await operation();
    } finally {
      release();
      if (this.credentialLocks.get(lockKey) === current) {
        this.credentialLocks.delete(lockKey);
      }
    }
  }

  private removeCachedCredential(credential: ManagedRuntimeCredential): void {
    const cacheKey = credentialCacheKey(credential);
    const cached = this.activeCredentials.get(cacheKey);
    if (cached?.apiKeyId === credential.apiKeyId) {
      this.activeCredentials.delete(cacheKey);
    }
  }

  private async contextExists(association: ContextApiKeyAssociation): Promise<boolean> {
    const workspace = await getWorkspace(association.workspaceId);
    if (!workspace) {
      return false;
    }

    switch (association.contextType) {
      case "task": {
        const task = await loadTaskSummary(association.contextId);
        return task?.config.workspaceId === association.workspaceId && task.state.status !== "deleted";
      }
      case "chat": {
        const chat = await loadChatMetadata(association.contextId);
        return chat?.config.workspaceId === association.workspaceId;
      }
      case "agent_run": {
        const run = await loadAgentRunSummary(association.contextId);
        return run?.configSnapshot.workspaceId === association.workspaceId
          && isAgentRunActiveStatus(run.status);
      }
      case "terminal_session": {
        const session = await getTerminalSession(association.contextId);
        return session?.config.workspaceId === association.workspaceId;
      }
    }
  }
}

export const managedCredentialService = new ManagedCredentialService();
