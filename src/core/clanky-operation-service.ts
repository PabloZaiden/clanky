/**
 * Catalog-backed operation discovery and safe, transport-neutral execution.
 */

import { z } from "zod";
import {
  buildCompiledRoutePath,
  compileRoutePatterns,
  findRouteCatalogEntry,
  resolveRouteOperation,
  routeSchemaToJsonSchema,
  type HttpMethod,
  type RouteCatalogEntry,
} from "@pablozaiden/webapp/server";
import { DomainError } from "../domain/domain-error";

export interface OperationRequest {
  method: HttpMethod;
  path: string;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

export interface OperationResult {
  ok: boolean;
  operationId: string;
  status?: number;
  completion: "completed" | "admission" | "not_executed" | "outcome_unknown";
  data?: unknown;
  code?: string;
  message?: string;
}

export interface OperationAuthority {
  allows: (entry: RouteCatalogEntry) => boolean;
  request: (request: OperationRequest) => Promise<Omit<OperationResult, "operationId" | "completion">>;
  refresh: (next: OperationAuthority) => void;
  release: () => void;
}

export const ExecuteOperationSchema = z.object({
  operationId: z.string().min(1).max(500),
  parameters: z.array(z.object({ name: z.string().min(1).max(100), value: z.string().max(16_384) }).strict()).max(16),
  query: z.array(z.object({ name: z.string().min(1).max(100), value: z.string().max(16_384) }).strict()).max(32),
  bodyJson: z.string().max(40_000).nullable(),
}).strict();
export type ExecuteOperationInput = z.infer<typeof ExecuteOperationSchema>;

type OperationMetadata = ReturnType<typeof resolveRouteOperation>;
export interface PreparedOperation {
  id: string;
  entry: RouteCatalogEntry;
  metadata: OperationMetadata;
  method: HttpMethod;
  path: string;
  body?: unknown;
  parameters: Readonly<Record<string, string>>;
  input: ExecuteOperationInput;
}

const SECRET_INPUTS = new Set([
  "apikey", "apikeys", "password", "credentialtoken", "encryptedcredential",
  "privatekey", "authorization", "cookie", "accesstoken", "refreshtoken",
]);

function assertSafeInputs(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_INPUTS.has(key.replace(/[-_]/g, "").toLowerCase())) {
      throw new DomainError("voice_operation_invalid", "Credential material is not a voice-tool input.");
    }
    assertSafeInputs(child);
  }
}

function namedValues(values: ExecuteOperationInput["query"]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const { name, value } of values) {
    if (Object.hasOwn(result, name)) throw new DomainError("voice_operation_invalid", `Duplicate input: ${name}`);
    result[name] = value;
  }
  return result;
}

function safeSchema(schema: unknown, hidden: readonly string[] = []): z.ZodType | undefined {
  if (schema === undefined || schema === null) return undefined;
  if (!(schema instanceof z.ZodType)) {
    throw new DomainError("voice_operation_contract", "This operation has no executable input validator.");
  }
  if (schema instanceof z.ZodDefault || schema instanceof z.ZodOptional) return safeSchema(schema.unwrap(), hidden);
  if (schema instanceof z.ZodObject) return z.strictObject(Object.fromEntries(
    Object.entries(schema.shape).filter(([name]) => !hidden.includes(name)),
  ));
  if (hidden.length) throw new DomainError("voice_operation_contract", "Hidden inputs require an object contract.");
  return schema;
}

export class ClankyOperationService {
  private readonly operations = new Map<string, { entry: RouteCatalogEntry; method: HttpMethod }>();

  constructor(private readonly catalog: readonly RouteCatalogEntry[]) {
    for (const entry of catalog) {
      for (const method of entry.methods) this.operations.set(`${method} ${entry.path}`, { entry, method });
    }
  }

  private requireOperation(id: string, authority: OperationAuthority) {
    const operation = this.operations.get(id);
    if (!operation || !authority.allows(operation.entry)) {
      throw new DomainError("voice_operation_unavailable", "The operation is unavailable to this call.");
    }
    const metadata = resolveRouteOperation(operation.entry, operation.method);
    if (!metadata.automation || metadata.automation.policy === "excluded") {
      throw new DomainError("voice_operation_unavailable", "This operation is not available through voice.");
    }
    return { ...operation, metadata };
  }

  find(authority: OperationAuthority, input: { text: string; domain: string | null; method: HttpMethod | null; cursor: number | null }) {
    const words = input.text.toLowerCase().split(/\s+/).filter(Boolean);
    const entries = [...this.operations].flatMap(([id, { entry, method }]) => {
      const metadata = resolveRouteOperation(entry, method);
      const policy = metadata.automation?.policy;
      if (!policy || policy === "excluded" || !authority.allows(entry)
        || input.method && method !== input.method
        || input.domain && ![entry.path, ...entry.tags].some((value) => value.includes(input.domain!))) return [];
      const description = metadata.description ?? `${method} ${entry.path}`;
      const searchable = `${entry.path} ${entry.tags.join(" ")} ${description}`.toLowerCase();
      if (!words.every((word) => searchable.includes(word))) return [];
      return [{ operationId: id, description, policy }];
    });
    const offset = input.cursor ?? 0;
    return { operations: entries.slice(offset, offset + 20), nextCursor: offset + 20 < entries.length ? offset + 20 : null };
  }

  describe(authority: OperationAuthority, id: string) {
    const { entry, method, metadata } = this.requireOperation(id, authority);
    const automation = metadata.automation!;
    return {
      operationId: id,
      description: metadata.description,
      policy: automation.policy,
      completion: automation.completion ?? "completed",
      parameters: compileRoutePatterns(entry.path, entry.cliPath).api.captures.map(({ name }) => name),
      querySchema: routeSchemaToJsonSchema(safeSchema(metadata.querySchema, automation.hiddenQuery)),
      requestSchema: routeSchemaToJsonSchema(safeSchema(metadata.requestSchema, automation.hiddenInputs)),
      method,
      requirements: automation.credential ? ["Originating browser SSH credential handoff"] : [],
    };
  }

  prepare(authority: OperationAuthority, input: ExecuteOperationInput): PreparedOperation {
    const { entry, method, metadata } = this.requireOperation(input.operationId, authority);
    const automation = metadata.automation!;
    const patterns = compileRoutePatterns(entry.path, entry.cliPath);
    const parameters = namedValues(input.parameters);
    const names = patterns.api.captures.map(({ name }) => name);
    if (Object.keys(parameters).length !== names.length || names.some((name) => !parameters[name])) {
      throw new DomainError("voice_operation_invalid", "Supply exactly the documented path parameters.");
    }
    const path = buildCompiledRoutePath(patterns.api, patterns.api.captures.map(({ name, kind }) => {
      const value = parameters[name]!;
      return { value, segments: kind === "wildcard" ? value.split("/") : [value] };
    }));
    const url = new URL(path, "http://clanky.invalid");
    const match = findRouteCatalogEntry(this.catalog, url.pathname);
    if (match?.entry.path !== entry.path
      || names.some((name) => match.params[name] !== parameters[name])) {
      throw new DomainError("voice_operation_invalid", "The normalized path does not identify the requested operation.");
    }
    const query = namedValues(input.query);
    assertSafeInputs(query);
    if (automation.hiddenQuery?.some((name) => Object.hasOwn(query, name))) {
      throw new DomainError("voice_operation_invalid", "This query input is not available through voice.");
    }
    const querySchema = safeSchema(metadata.querySchema, automation.hiddenQuery);
    if (!querySchema && Object.keys(query).length) throw new DomainError("voice_operation_invalid", "This operation has no query inputs.");
    const parsedQuery = querySchema?.parse(query);
    if (parsedQuery && typeof parsedQuery === "object") {
      for (const [name, value] of Object.entries(parsedQuery)) {
        if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
      }
    }
    let body: unknown;
    if (input.bodyJson !== null) {
      body = JSON.parse(input.bodyJson);
      assertSafeInputs(body);
    }
    const bodySchema = safeSchema(metadata.requestSchema, automation.hiddenInputs);
    if (bodySchema) body = bodySchema.parse(body ?? {});
    else if (input.bodyJson !== null && input.bodyJson !== "{}") {
      throw new DomainError("voice_operation_invalid", "This operation has no request body.");
    }
    return { id: input.operationId, entry, method, metadata, path: `${url.pathname}${url.search}`, body, parameters, input };
  }

  async targetRevision(authority: OperationAuthority, prepared: PreparedOperation, signal: AbortSignal): Promise<string | null> {
    const target = this.catalog.filter((entry) => prepared.entry.path.startsWith(entry.path)
      && entry.methods.includes("GET")
      && compileRoutePatterns(entry.path, entry.cliPath).api.captures.length > 0
      && resolveRouteOperation(entry, "GET").automation?.policy === "read"
      && (safeSchema(resolveRouteOperation(entry, "GET").querySchema,
        resolveRouteOperation(entry, "GET").automation.hiddenQuery)?.safeParse({}).success ?? true)
      && authority.allows(entry)).sort((left, right) => right.path.length - left.path.length)[0];
    if (!target) return null;
    const names = compileRoutePatterns(target.path, target.cliPath).api.captures.map(({ name }) => name);
    const read = this.prepare(authority, {
      operationId: `GET ${target.path}`, parameters: names.map((name) => ({ name, value: prepared.parameters[name]! })),
      query: [], bodyJson: null,
    });
    const result = await this.execute(authority, read, { signal, clientId: "" });
    if (!result.ok) throw new DomainError("voice_operation_target", "The target could not be verified before confirmation.");
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(result.data, (key, value: unknown) =>
      ["lastActivityAt", "updatedAt", "logs", "messages", "toolCalls"].includes(key) ? undefined : value)).digest("hex");
  }

  async execute(authority: OperationAuthority, prepared: PreparedOperation, options: {
    signal: AbortSignal;
    clientId: string;
    credentialToken?: string | null;
    credentialTokens?: Readonly<Record<string, string>>;
    unavailableServerIds?: readonly string[];
  }): Promise<OperationResult> {
    this.requireOperation(prepared.id, authority);
    const automation = prepared.metadata.automation!;
    let body = prepared.body;
    const headers: Record<string, string> = {};
    if (automation.hiddenInputs?.includes("clientId")) {
      body = { ...(body && typeof body === "object" ? body : {}), clientId: options.clientId };
    }
    if (automation.credential) {
      if (automation.credential.input) body = { ...(body && typeof body === "object" ? body : {}), [automation.credential.input]: options.credentialToken };
      if (automation.credential.header && options.credentialToken) headers[automation.credential.header] = options.credentialToken;
      if (automation.credential.mapInput) body = { ...(body && typeof body === "object" ? body : {}), [automation.credential.mapInput]: options.credentialTokens ?? {} };
      if (automation.credential.unavailableInput) body = { ...(body && typeof body === "object" ? body : {}), [automation.credential.unavailableInput]: options.unavailableServerIds ?? [] };
    }
    if (prepared.metadata.requestSchema instanceof z.ZodType) {
      body = prepared.metadata.requestSchema.parse(body);
    }
    const result = await authority.request({
      method: prepared.method, path: prepared.path, body, headers, signal: options.signal,
    });
    return {
      ...result,
      operationId: prepared.id,
      completion: result.ok ? automation.completion ?? "completed"
        : automation.policy === "read" ? "not_executed" : "outcome_unknown",
    };
  }
}
