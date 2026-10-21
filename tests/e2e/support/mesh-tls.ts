/**
 * Isolated TLS identity shared by the real Mesh processes in one E2E file.
 */
import "reflect-metadata";
import { afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BasicConstraintsExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";

interface MeshTestTls {
  directory: string;
  certificate: string;
  certificatePath: string;
  privateKeyPath: string;
}

let identity: Promise<MeshTestTls> | undefined;

async function createIdentity(): Promise<MeshTestTls> {
  const directory = await mkdtemp(join(tmpdir(), "clanky-mesh-tls-"));
  try {
    const algorithm = {
      name: "RSASSA-PKCS1-v1_5", hash: "SHA-256",
      publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048,
    } as const;
    const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
    const generated = await X509CertificateGenerator.createSelfSigned({
      name: "CN=Clanky Mesh E2E",
      keys,
      signingAlgorithm: algorithm,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 86_400_000),
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new SubjectAlternativeNameExtension([
          { type: "ip", value: "127.0.0.1" },
          { type: "dns", value: "localhost" },
        ]),
      ],
    });
    const certificate = generated.toString("pem");
    const certificatePath = join(directory, "certificate.pem");
    const privateKeyPath = join(directory, "private-key.pem");
    const key = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey))
      .toString("base64").match(/.{1,64}/g)!.join("\n");
    await Bun.write(certificatePath, certificate, { mode: 0o600 });
    await Bun.write(privateKeyPath, `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 });
    return { directory, certificate, certificatePath, privateKeyPath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function getMeshTestTls(): Promise<MeshTestTls> {
  identity ??= createIdentity();
  return await identity;
}

afterAll(async () => {
  if (identity) {
    const tls = await identity;
    await rm(tls.directory, { recursive: true, force: true });
  }
});
