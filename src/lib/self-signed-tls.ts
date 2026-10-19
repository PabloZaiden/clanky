/**
 * Self-signed server identities for explicitly trusted development transports.
 */

import "reflect-metadata";
import { isIP } from "node:net";
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";

export async function createSelfSignedTlsIdentity(options: {
  name: string;
  hostnames: string[];
  notBefore: Date;
  notAfter: Date;
}): Promise<{ certificate: string; privateKey: string }> {
  const algorithm = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
  } as const;
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: options.name,
    keys,
    signingAlgorithm: algorithm,
    notBefore: options.notBefore,
    notAfter: options.notAfter,
    extensions: [
      // Bun's per-connection CA validation requires a self-signed trust anchor.
      new BasicConstraintsExtension(true, 0, true),
      new KeyUsagesExtension(
        KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment | KeyUsageFlags.keyCertSign,
        true,
      ),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth], true),
      new SubjectAlternativeNameExtension(options.hostnames.map((hostname) => ({
        type: isIP(hostname) > 0 ? "ip" as const : "dns" as const,
        value: hostname,
      }))),
      await SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey))
    .toString("base64").match(/.{1,64}/g)!.join("\n");
  return {
    certificate: certificate.toString("pem"),
    privateKey: `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----\n`,
  };
}
