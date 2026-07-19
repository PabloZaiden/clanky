/**
 * Short-lived in-memory credential handoff for standalone SSH servers.
 */

import type { SshCredentialExchangeResponse, SshServerEncryptedCredential } from "@/shared";
import { sshServerKeyManager } from "./ssh-server-key-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "./domain-error";

const log = createLogger("core:ssh-credential-manager");
const DEFAULT_CREDENTIAL_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_CREDENTIAL_TOKENS = 256;

interface CredentialTokenRecord {
  serverId: string;
  password: string;
  expiresAt: number;
}

export class SshCredentialManager {
  private readonly tokens = new Map<string, CredentialTokenRecord>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly tokenTtlMs: number = DEFAULT_CREDENTIAL_TOKEN_TTL_MS,
  ) {}

  async issueToken(
    serverId: string,
    encryptedCredential: SshServerEncryptedCredential,
  ): Promise<SshCredentialExchangeResponse> {
    this.evictExpiredTokens();
    this.evictOverflowTokens();

    const password = await sshServerKeyManager.decryptCredential(serverId, encryptedCredential);
    const token = crypto.randomUUID();
    const expiresAt = this.now() + this.tokenTtlMs;
    this.tokens.set(token, {
      serverId,
      password,
      expiresAt,
    });

    log.debug("Issued standalone SSH credential token", {
      serverId,
      expiresAt: new Date(expiresAt).toISOString(),
    });

    return {
      credentialToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  getPasswordForToken(serverId: string, token: string): string {
    this.evictExpiredTokens();
    const record = this.tokens.get(token);
    if (!record) {
      throw new DomainError(
        "invalid_credential_token",
        "SSH credential token is missing or expired",
      );
    }
    if (record.serverId !== serverId) {
      this.tokens.delete(token);
      throw new DomainError(
        "invalid_credential_token",
        "SSH credential token does not belong to the requested server",
      );
    }

    return record.password;
  }

  clearTokensForServer(serverId: string): void {
    for (const [token, record] of this.tokens.entries()) {
      if (record.serverId === serverId) {
        this.tokens.delete(token);
      }
    }
  }

  getTokenCountForTesting(): number {
    this.evictExpiredTokens();
    return this.tokens.size;
  }

  private evictExpiredTokens(): void {
    const now = this.now();
    for (const [token, record] of this.tokens.entries()) {
      if (record.expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }

  private evictOverflowTokens(): void {
    while (this.tokens.size >= MAX_CREDENTIAL_TOKENS) {
      const oldest = this.tokens.keys().next().value;
      if (!oldest) {
        return;
      }
      this.tokens.delete(oldest);
    }
  }
}

export const sshCredentialManager = new SshCredentialManager();
