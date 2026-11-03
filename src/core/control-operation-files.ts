import type { RouteAutomationMetadata } from "@/platform/server";
import { z } from "zod";
import {
  CONTROL_PRIVATE_HEADERS_MAX_BYTES, CONTROL_PRIVATE_JSON_MAX_BYTES, type ExecuteOperationInput,
} from "@/contracts/schemas/control";
import { DomainError } from "../domain/domain-error";
import { closeCommandExecutor } from "./command-executor";
import { executionHostService } from "./execution-host-service";
import { dirnameExecutionPath, isAbsoluteExecutionPath, joinExecutionPath, normalizeExecutionRoot } from "./execution-path";
import type { ControlGrant } from "./control-authority";
import type { OperationFiles } from "./clanky-operation-service";

export async function prepareControlOperationFiles(
  grant: ControlGrant, input: ExecuteOperationInput, automation: RouteAutomationMetadata, signal: AbortSignal,
): Promise<OperationFiles> {
  const binding = grant.executionHostBinding;
  if (!binding) throw new DomainError("control_files_unavailable", "The admitted execution host is unavailable.");
  const executor = await executionHostService.getCommandExecutor(binding, {
    directory: ".", localUserId: grant.user.id, operationId: `control-files:${crypto.randomUUID()}`,
  });
  let temporaryDirectory: string | undefined;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => releasing ??= (async () => {
    try {
      if (temporaryDirectory
        && !await executor.deletePath(temporaryDirectory, { kind: "directory", recursive: true })) {
        throw new DomainError("control_file_cleanup_failed", "The private operation files could not be removed.");
      }
    } finally { closeCommandExecutor(executor); }
  })();
  try {
    const absolutePath = (path: string): string => {
      if (!isAbsoluteExecutionPath(path, executor.pathStyle)) {
        throw new DomainError("control_file_path_invalid", "Control file references must be absolute paths on the execution host.");
      }
      return normalizeExecutionRoot(path, executor.pathStyle);
    };
    const source = input.bodyFile ? absolutePath(input.bodyFile.path) : undefined;
    const headerSource = input.headersFile ? absolutePath(input.headersFile.path) : undefined;
    const destination = input.responseFile ? absolutePath(input.responseFile.path) : undefined;
    if (!executor.writeFileStream) {
      throw new DomainError("control_files_unavailable", "The execution host does not support streaming file writes.");
    }
    const writeStream = executor.writeFileStream.bind(executor);
    const existing = destination ? await executor.getFileMetadata(destination, { includeContentHash: false, signal }) : null;
    if (existing && existing.kind !== "file") {
      throw new DomainError("control_file_path_invalid", "The response destination must be a file, not a directory.");
    }
    if (existing && !input.responseFile?.overwrite) {
      throw new DomainError("control_file_exists", "The response destination already exists; explicitly allow overwrite or choose another path.");
    }
    const root = destination ? dirnameExecutionPath(destination, executor.pathStyle)
      : absolutePath(await executor.getEnvironmentVariable("TMPDIR") || "/tmp");
    const reservation = joinExecutionPath(executor.pathStyle, root, `clanky-control-${crypto.randomUUID()}`);
    const created = await executor.exec("mkdir", ["-m", "700", reservation], { signal, timeout: 5_000, logFailures: false });
    if (!created.success) throw new DomainError("control_files_unavailable", "A private operation directory could not be created on the execution host.");
    temporaryDirectory = reservation;
    const frozenPath = joinExecutionPath(executor.pathStyle, reservation, "request");
    let body: unknown;
    let headers: Record<string, string> | undefined;
    const raw = automation.execution?.requestFormat === "raw";
    const sizeLimitError = (maxBytes: number) => new DomainError(
      "control_file_too_large", `The private input file exceeds the ${maxBytes} byte limit.`,
    );
    const freeze = async (path: string, frozen: string, maxBytes?: number): Promise<void> => {
      const sourceMetadata = await executor.getFileMetadata(path, { includeContentHash: false, signal });
      if (sourceMetadata?.kind !== "file") throw new DomainError("control_file_unavailable", "The input must be an existing file on the execution host.");
      if (maxBytes !== undefined && sourceMetadata.size > maxBytes) throw sizeLimitError(maxBytes);
      if (!executor.copyFile) throw new DomainError("control_files_unavailable", "The execution host does not support host-side file copying.");
      signal.throwIfAborted();
      if (!await executor.copyFile(path, frozen)) throw new DomainError("control_file_unavailable", "The input file could not be frozen.");
      signal.throwIfAborted();
      const frozenMetadata = await executor.getFileMetadata(frozen, { includeContentHash: false, signal });
      if (frozenMetadata?.kind !== "file") throw new DomainError("control_file_unavailable", "The frozen input file is unavailable.");
      if (maxBytes !== undefined && frozenMetadata.size > maxBytes) throw sizeLimitError(maxBytes);
    };
    const readJson = async (path: string, maxBytes: number): Promise<unknown> => {
      const stream = await executor.streamFile(path, { signal });
      if (!stream) throw new DomainError("control_file_unavailable", "The frozen JSON input could not be read.");
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let content = "";
      let bytes = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) throw sizeLimitError(maxBytes);
          content += decoder.decode(value, { stream: true });
        }
        content += decoder.decode();
      } finally {
        try { await reader.cancel(); }
        finally { reader.releaseLock(); }
      }
      try { return JSON.parse(content); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new DomainError("control_body_invalid", "The private input file must contain valid JSON.");
      }
    };
    if (source) {
      await freeze(source, frozenPath, raw ? undefined : CONTROL_PRIVATE_JSON_MAX_BYTES);
      if (!raw) {
        if (!input.bodyFile?.contentType.toLowerCase().startsWith("application/json")) {
          throw new DomainError("control_body_invalid", "JSON operations require an application/json bodyFile.");
        }
        body = await readJson(frozenPath, CONTROL_PRIVATE_JSON_MAX_BYTES);
      }
    }
    if (headerSource) {
      const allowed = automation.execution?.requestHeaders ?? [];
      if (!allowed.length) throw new DomainError("control_headers_invalid", "This operation does not declare request headers.");
      const frozenHeaders = joinExecutionPath(executor.pathStyle, reservation, "headers");
      await freeze(headerSource, frozenHeaders, CONTROL_PRIVATE_HEADERS_MAX_BYTES);
      const parsed = z.record(z.string(), z.string()).parse(await readJson(frozenHeaders, CONTROL_PRIVATE_HEADERS_MAX_BYTES));
      const validatedHeaders: Record<string, string> = Object.create(null);
      for (const [name, value] of Object.entries(parsed)) {
        const normalized = name.toLowerCase();
        if (!allowed.includes(normalized) || Object.hasOwn(validatedHeaders, normalized) || /[\r\n\0]/.test(value)) {
          throw new DomainError("control_headers_invalid", "Supply each declared request header once with a valid value.");
        }
        validatedHeaders[normalized] = value;
      }
      headers = validatedHeaders;
    }
    return {
      body, headers, raw, contentType: input.bodyFile?.contentType, release, responseFile: !!destination,
      requestBody: async (requestSignal) => {
        if (!source || !raw) return undefined;
        const stream = await executor.streamFile(frozenPath, { signal: requestSignal });
        if (!stream) throw new DomainError("control_file_unavailable", "The frozen operation input is unavailable.");
        return stream;
      },
      saveResponse: async (responseBody, response) => {
        const responseSignal = response.signal;
        if (!destination) throw new DomainError("control_response_file_required", "Choose a responseFile for this response.");
        const stream = responseBody ?? new Blob().stream();
        const staged = joinExecutionPath(executor.pathStyle, reservation, "response");
        if (!await executor.writeFile(staged, "")) {
          await stream.cancel();
          throw new DomainError("control_response_file_failed", "The response file could not be initialized.");
        }
        const secured = await executor.exec("chmod", ["600", staged], { signal: responseSignal, timeout: 5_000, logFailures: false });
        if (!secured.success) {
          await stream.cancel();
          throw new DomainError("control_response_file_failed", "The response file could not be secured.");
        }
        const result = await writeStream(staged, stream, { signal: responseSignal });
        if (!result.success) throw new DomainError("control_response_file_failed", "The response could not be saved. Inspect the operation target before repeating a mutation.");
        // A same-filesystem link publishes without a check/rename overwrite race.
        const published = input.responseFile?.overwrite
          ? await executor.movePath(staged, destination, { overwrite: true })
          : await executor.exec("link", [staged, destination], { signal: responseSignal, timeout: 5_000, logFailures: false });
        if (!published.success) throw new DomainError("control_response_file_failed", "The response destination could not be published. Inspect the operation target before repeating a mutation.");
        return {
          ok: response.ok, status: response.status,
          data: { file: { path: destination, bytes: result.bytesWritten, contentType: response.contentType } },
        };
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}
