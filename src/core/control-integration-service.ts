import {
  createManagedApiKey, listManagedApiKeys, revokeManagedApiKey,
  type WebAppStore, type ManagedApiKeySummary,
} from "@pablozaiden/webapp/server";
import {
  ControlGrantSelectionSchema, ControlCredentialSummarySchema,
  type ControlGrantSelection, type ControlCredentialSummary, type CreateControlCredentialSchema,
} from "@/contracts/schemas/control";
import type { z } from "zod";
import { CLANKY_CONTROL_GENERAL_SCOPE, controlWorkspaceScope } from "@/shared/context-api-key";
import { requireCurrentUser } from "../context/user-context";
import { getWorkspace, listWorkspaces } from "../persistence/workspaces";
import { DomainError } from "../domain/domain-error";
import { controlGrantScopes } from "./control-authority";

const MANAGED_BY = "clanky.control-integration";
const MAX_CREDENTIALS = 32;

export class ControlIntegrationService {
  constructor(private readonly store: WebAppStore) {}

  async consentOptions() {
    return {
      workspaces: (await listWorkspaces()).map(({ id, name }) => ({ id, name })),
      generalAllowed: true,
    };
  }

  async selection(input: unknown): Promise<ControlGrantSelection> {
    const selection = ControlGrantSelectionSchema.parse(input);
    if (selection.level === "workspace" && !await getWorkspace(selection.workspaceId)) {
      throw new DomainError("control_workspace_unavailable", "Choose an owned workspace that is available on this controller.");
    }
    return selection;
  }

  list(): ControlCredentialSummary[] {
    return listManagedApiKeys(this.store, requireCurrentUser().id, MANAGED_BY).map((key) => this.summary(key));
  }

  async create(input: z.infer<typeof CreateControlCredentialSchema>): Promise<{
    credential: ControlCredentialSummary; token: string;
  }> {
    const grant = await this.selection(input.grant);
    if (this.list().length >= MAX_CREDENTIALS) {
      throw new DomainError("control_credential_limit", "Revoke an unused integration before creating another credential.");
    }
    const { key, token } = createManagedApiKey(this.store, requireCurrentUser(), {
      managedBy: MANAGED_BY, prefix: "clanky_control", name: input.name,
      scopes: controlGrantScopes(grant), expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
    });
    return { credential: this.summary(key), token };
  }

  revoke(id: string): void {
    const user = requireCurrentUser();
    const key = listManagedApiKeys(this.store, user.id, MANAGED_BY).find((candidate) => candidate.id === id);
    if (!key || !revokeManagedApiKey(this.store, id, user.id)) {
      throw new DomainError("control_credential_unavailable", "The integration credential is unavailable.");
    }
  }

  private summary(key: ManagedApiKeySummary): ControlCredentialSummary {
    const workspace = key.scopes.find((scope) => scope.startsWith(controlWorkspaceScope("")));
    return ControlCredentialSummarySchema.parse({
      id: key.id, name: key.name,
      grant: key.scopes.includes(CLANKY_CONTROL_GENERAL_SCOPE) ? { level: "general" }
        : { level: "workspace", workspaceId: workspace?.slice(controlWorkspaceScope("").length) },
      createdAt: key.createdAt, expiresAt: key.expiresAt,
    });
  }
}
