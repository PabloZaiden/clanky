import { DomainError } from "../domain/domain-error";
import type { OperationResult } from "../core/clanky-operation-service";

const MAX_RESPONSE_BYTES = 200_000;

export async function readOperationResponse(
  response: Response | undefined, prefix: "voice" | "control",
): Promise<Omit<OperationResult, "operationId" | "completion">> {
  if (!response) throw new DomainError(`${prefix}_operation_response`, "The operation returned no HTTP response.");
  if (response.status === 204) return { ok: true, status: 204, data: null };
  if (!response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    return { ok: false, status: response.status, code: `${prefix}_operation_response`, message: "The operation did not return JSON." };
  }
  const reader = response.body?.getReader();
  if (!reader) throw new DomainError(`${prefix}_operation_response`, "The operation returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return { ok: false, status: response.status, code: `${prefix}_operation_response_too_large`,
          message: `The response exceeds ${MAX_RESPONSE_BYTES} bytes. Use paging or a targeted read. A successful mutation may already have taken effect; do not repeat it.` };
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return { ok: response.ok, status: response.status, data };
}
