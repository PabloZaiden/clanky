/**
 * Minimal standards-compliant WebAuthn registration client for black-box E2E.
 */

import { isoCBOR } from "@simplewebauthn/server/helpers";

interface RegistrationOptions {
  challenge: string;
  rp: {
    id?: string;
  };
}

interface RegistrationResponse {
  id: string;
  rawId: string;
  response: {
    attestationObject: string;
    clientDataJSON: string;
    transports: ["internal"];
    publicKeyAlgorithm: -7;
  };
  authenticatorAttachment: "platform";
  clientExtensionResults: {
    credProps: {
      rk: true;
    };
  };
  type: "public-key";
}

type CborValue =
  | boolean
  | null
  | number
  | string
  | Uint8Array
  | CborValue[]
  | Map<string | number, CborValue>;

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function concatenate(...arrays: Uint8Array[]): Uint8Array {
  const length = arrays.reduce((total, array) => total + array.byteLength, 0);
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) {
    combined.set(array, offset);
    offset += array.byteLength;
  }
  return combined;
}

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
}

export async function createPasskeyRegistration(
  options: RegistrationOptions,
  origin: string,
): Promise<RegistrationResponse> {
  const rpId = options.rp.id;
  if (!rpId) {
    throw new Error("WebAuthn registration options did not include an RP ID");
  }
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  if (publicKey.byteLength !== 65 || publicKey[0] !== 0x04) {
    throw new Error("WebAuthn fixture generated an invalid P-256 public key");
  }
  const credentialPublicKey = Uint8Array.from(isoCBOR.encode(
    new Map<string | number, CborValue>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, publicKey.slice(1, 33)],
    [-3, publicKey.slice(33, 65)],
    ]),
  ));
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
  );
  const authenticatorData = concatenate(
    rpIdHash,
    new Uint8Array([0x45]),
    new Uint8Array(4),
    new Uint8Array(16),
    uint16(credentialId.byteLength),
    credentialId,
    credentialPublicKey,
  );
  const clientData = new TextEncoder().encode(JSON.stringify({
    type: "webauthn.create",
    challenge: options.challenge,
    origin,
    crossOrigin: false,
  }));
  const attestationObject = isoCBOR.encode(
    new Map<string | number, CborValue>([
      ["fmt", "none"],
      ["attStmt", new Map<string | number, CborValue>()],
      ["authData", authenticatorData],
    ]),
  );

  return {
    id: base64Url(credentialId),
    rawId: base64Url(credentialId),
    response: {
      attestationObject: base64Url(attestationObject),
      clientDataJSON: base64Url(clientData),
      transports: ["internal"],
      publicKeyAlgorithm: -7,
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: {
      credProps: {
        rk: true,
      },
    },
    type: "public-key",
  };
}

export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator < 1) {
        continue;
      }
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) {
        this.cookies.set(name, value);
      } else {
        this.cookies.delete(name);
      }
    }
  }

  header(): string {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}
