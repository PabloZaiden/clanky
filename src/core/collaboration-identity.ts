/**
 * Pairing-key generation and public identity validation.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { z } from "zod";
import type { MeshRelayPeerIdentity } from "@/shared/mesh-relay";
import { MeshRelayPeerIdentitySchema } from "@/contracts/schemas/mesh-relay";
import { DomainError } from "../domain/domain-error";
import { getMeshRelayFingerprint } from "./mesh-relay-identity";

export function parseCollaborationInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DomainError("collaboration_input_invalid", "The collaboration request is invalid.", {
      details: { issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."), code: issue.code,
      })) },
    });
  }
  return result.data;
}

export function validateCollaborationIdentity(input: MeshRelayPeerIdentity): MeshRelayPeerIdentity {
  const identity = parseCollaborationInput(MeshRelayPeerIdentitySchema, input);
  try {
    if (getMeshRelayFingerprint(identity.publicKey) !== identity.fingerprint) {
      throw new Error("The public key does not match its fingerprint.");
    }
  } catch (error) {
    throw new DomainError("collaboration_identity_invalid", "The pairing identity is invalid.", { cause: error });
  }
  return identity;
}

export function generateCollaborationIdentity(): { identity: MeshRelayPeerIdentity; privateKey: string } {
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  return {
    identity: { nodeId: randomUUID(), publicKey: keys.publicKey, fingerprint: getMeshRelayFingerprint(keys.publicKey) },
    privateKey: keys.privateKey,
  };
}

export function createCollaborationSigner(
  identity: MeshRelayPeerIdentity,
  privateKeyPem: string,
): (payload: string) => string {
  try {
    validateCollaborationIdentity(identity);
    const privateKey = createPrivateKey(privateKeyPem);
    const derived = createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString();
    if (privateKey.asymmetricKeyType !== "ed25519" || derived !== identity.publicKey) {
      throw new Error("The stored pairing key does not match its public identity.");
    }
    return (payload: string) => sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
  } catch (error) {
    throw new DomainError("collaboration_identity_invalid", "The stored pairing identity is invalid.", { cause: error });
  }
}
