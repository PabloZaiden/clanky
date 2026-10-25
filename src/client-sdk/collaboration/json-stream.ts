/**
 * Retains JSON-stream heartbeats while qualifying the final structured result.
 */
import { DomainError } from "../../domain/domain-error";

export function workspaceJsonResponseStream(options: {
  maxBytes: number;
  qualify(value: unknown): unknown;
  failed(): void;
}): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let bytes = 0;
  let json = "";
  return new TransformStream({
    transform(chunk, controller) {
      try {
        bytes += chunk.byteLength;
        if (bytes > options.maxBytes) {
          throw new DomainError("collaboration_response_too_large", "The shared JSON stream exceeds its transfer budget.");
        }
        const text = decoder.decode(chunk, { stream: true });
        if (json.length) json += text;
        else {
          const prefix = /^[ \t\r\n]*/.exec(text)![0];
          if (prefix) controller.enqueue(encoder.encode(prefix));
          json = text.slice(prefix.length);
        }
      } catch (error) {
        options.failed();
        throw error;
      }
    },
    flush(controller) {
      try {
        json += decoder.decode();
        let value: unknown;
        try {
          value = JSON.parse(json);
        } catch (cause) {
          throw new DomainError("collaboration_response_invalid", "The shared JSON stream is invalid.", { cause });
        }
        controller.enqueue(encoder.encode(JSON.stringify(options.qualify(value))));
      } catch (error) {
        options.failed();
        throw error;
      }
    },
  });
}
