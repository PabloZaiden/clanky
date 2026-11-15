import { createHash } from "node:crypto";
import net from "node:net";
import { DomainError } from "../domain/domain-error";
import { SSH_AGENT_MAX_FRAME_BYTES, SSH_AGENT_MAX_KEY_BYTES, type SshAgentIdentity } from "@/shared/ssh-key-access";

export const SSH_AGENT_FAILURE = Buffer.from([5]);
export function sshAgentError(code: string, message: string): DomainError {
  return new DomainError(`ssh_agent_${code}`, message);
}
export function decodeSshBase64(value: string, maximum = SSH_AGENT_MAX_FRAME_BYTES): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw sshAgentError("protocol_invalid", "The SSH-agent message encoding is invalid.");
  }
  const result = Buffer.from(value, "base64");
  if (result.length > maximum || result.toString("base64") !== value) {
    throw sshAgentError("protocol_invalid", "The SSH-agent message exceeds its size bound.");
  }
  return result;
}
export function sshUint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}
export function sshString(value: Uint8Array | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([sshUint32(bytes.length), bytes]);
}
export function sshFrame(payload: Uint8Array): Buffer {
  if (!payload.length || payload.length > SSH_AGENT_MAX_FRAME_BYTES) {
    throw sshAgentError("protocol_invalid", "The SSH-agent frame length is invalid.");
  }
  return Buffer.concat([sshUint32(payload.length), payload]);
}
export class SshReader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}
  uint32(): number {
    if (this.offset + 4 > this.data.length) throw sshAgentError("protocol_invalid", "The SSH-agent message is truncated.");
    const result = this.data.readUInt32BE(this.offset);
    this.offset += 4;
    return result;
  }
  string(maximum = SSH_AGENT_MAX_KEY_BYTES): Buffer {
    const length = this.uint32();
    if (length > maximum || this.offset + length > this.data.length) {
      throw sshAgentError("protocol_invalid", "The SSH-agent field length is invalid.");
    }
    const result = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  end(): void {
    if (this.offset !== this.data.length) throw sshAgentError("protocol_invalid", "The SSH-agent message has trailing bytes.");
  }
}
export function sshIdentity(publicKey: Buffer, comment: string): SshAgentIdentity {
  if (publicKey.length > SSH_AGENT_MAX_KEY_BYTES) throw sshAgentError("protocol_invalid", "The SSH public key is too large.");
  const type = new SshReader(publicKey).string(128).toString("ascii");
  if (!/^[a-zA-Z0-9@._+-]+$/.test(type)) throw sshAgentError("protocol_invalid", "The SSH public key type is invalid.");
  return {
    publicKey: publicKey.toString("base64"),
    fingerprint: `SHA256:${createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "")}`,
    comment: comment.slice(0, 1024),
  };
}
export type SshAllowedRequest = { kind: "identities" } | { kind: "sign"; publicKey: string; data: string; flags: 0 | 2 | 4 };
export function parseSshAgentRequest(payload: Buffer): SshAllowedRequest {
  if (!payload.length || payload.length > SSH_AGENT_MAX_FRAME_BYTES) throw sshAgentError("protocol_invalid", "The SSH-agent frame length is invalid.");
  const reader = new SshReader(payload.subarray(1));
  if (payload[0] === 11) {
    reader.end();
    return { kind: "identities" };
  }
  if (payload[0] !== 13) throw sshAgentError("operation_forbidden", "Only SSH-agent identity listing and signing are permitted.");
  const publicKey = reader.string().toString("base64");
  const data = reader.string(SSH_AGENT_MAX_FRAME_BYTES).toString("base64");
  const flags = reader.uint32();
  reader.end();
  if (flags !== 0 && flags !== 2 && flags !== 4) throw sshAgentError("operation_forbidden", "The SSH-agent signing flags are unsupported.");
  return { kind: "sign", publicKey, data, flags };
}
export function sshIdentityResponse(identities: SshAgentIdentity[]): Buffer {
  if (identities.length > 256) throw sshAgentError("protocol_invalid", "The scoped SSH agent has too many granted identities.");
  const parts = [Buffer.from([12]), sshUint32(identities.length)];
  let length = 5;
  for (const identity of identities) {
    const key = sshString(decodeSshBase64(identity.publicKey, SSH_AGENT_MAX_KEY_BYTES));
    const comment = sshString(identity.comment);
    length += key.length + comment.length;
    if (length > SSH_AGENT_MAX_FRAME_BYTES) throw sshAgentError("protocol_invalid", "The scoped SSH-agent identity response exceeds its size bound.");
    parts.push(key, comment);
  }
  return Buffer.concat(parts, length);
}
export async function requestSourceAgent(socketPath: string | undefined, payload: Buffer): Promise<Buffer> {
  if (!socketPath) throw sshAgentError("source_unavailable", "The selected host has no explicitly available SSH agent.");
  return await new Promise<Buffer>((resolve, reject) => {
    let response: Buffer = Buffer.alloc(0);
    let settled = false;
    const socket = net.createConnection(socketPath);
    const finish = (error?: unknown, result?: Buffer): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    socket.setTimeout(5000, () => finish(sshAgentError("source_unavailable", "The selected SSH agent timed out.")));
    socket.once("connect", () => socket.write(sshFrame(payload)));
    socket.on("data", (chunk: Buffer) => {
      if (response.length + chunk.length > SSH_AGENT_MAX_FRAME_BYTES + 4) {
        finish(sshAgentError("protocol_invalid", "The source SSH-agent response is too large."));
        return;
      }
      response = Buffer.concat([response, chunk]);
      if (response.length < 4) return;
      const length = response.readUInt32BE(0);
      if (!length || length > SSH_AGENT_MAX_FRAME_BYTES || response.length > length + 4) {
        finish(sshAgentError("protocol_invalid", "The source SSH-agent frame is invalid."));
      } else if (response.length === length + 4) {
        if (response[4] === 5) finish(sshAgentError("key_unavailable", "The source SSH agent refused the key operation."));
        else finish(undefined, response.subarray(4));
      }
    });
    socket.once("error", () => finish(sshAgentError("source_unavailable", "The selected SSH agent is disconnected or unavailable.")));
    socket.once("close", () => finish(sshAgentError("source_unavailable", "The selected SSH agent closed before responding.")));
  });
}
export async function listSourceAgentIdentities(socketPath: string | undefined): Promise<SshAgentIdentity[]> {
  const response = await requestSourceAgent(socketPath, Buffer.from([11]));
  if (response[0] !== 12) throw sshAgentError("protocol_invalid", "The source SSH agent returned an invalid identity response.");
  const reader = new SshReader(response.subarray(1));
  const count = reader.uint32();
  if (count > 256) throw sshAgentError("protocol_invalid", "The source SSH agent returned too many identities.");
  const result: SshAgentIdentity[] = [];
  for (let index = 0; index < count; index++) result.push(sshIdentity(reader.string(), reader.string(1024).toString("utf8")));
  reader.end();
  return result;
}
export async function signWithSourceAgent(socketPath: string | undefined, request: Extract<SshAllowedRequest, { kind: "sign" }>): Promise<Buffer> {
  const identities = await listSourceAgentIdentities(socketPath);
  if (!identities.some((identity) => identity.publicKey === request.publicKey)) {
    throw sshAgentError("key_unavailable", "The selected key is not loaded in its source SSH agent.");
  }
  const response = await requestSourceAgent(socketPath, Buffer.concat([
    Buffer.from([13]), sshString(decodeSshBase64(request.publicKey, SSH_AGENT_MAX_KEY_BYTES)),
    sshString(decodeSshBase64(request.data)), sshUint32(request.flags),
  ]));
  if (response[0] !== 14) throw sshAgentError("protocol_invalid", "The source SSH agent returned an invalid signature response.");
  const reader = new SshReader(response.subarray(1));
  reader.string(SSH_AGENT_MAX_FRAME_BYTES);
  reader.end();
  return response;
}
