import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";

export function getTlsCertificateFingerprint(certificate: string): string {
  const parsed = new X509Certificate(certificate);
  return `sha256:${createHash("sha256").update(parsed.raw).digest("hex")}`;
}

export function assertSelfSignedTlsCertificate(
  certificate: string,
  hostname: string,
  expectedFingerprint?: string,
): string {
  if (!/^\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/.test(certificate)) {
    throw new Error("TLS trust must contain exactly one PEM certificate.");
  }
  const parsed = new X509Certificate(certificate);
  const now = Date.now();
  if (now < Date.parse(parsed.validFrom) || now >= Date.parse(parsed.validTo)) {
    throw new Error("The TLS certificate is not currently valid.");
  }
  if (!parsed.verify(parsed.publicKey)) {
    throw new Error("The TLS trust certificate must be self-signed.");
  }
  const name = hostname.replace(/^\[|\]$/g, "");
  if (!(isIP(name) ? parsed.checkIP(name) : parsed.checkHost(name))) {
    throw new Error("The TLS certificate does not cover the endpoint hostname.");
  }
  const fingerprint = getTlsCertificateFingerprint(certificate);
  if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprint) {
    throw new Error("The TLS certificate does not match its trusted fingerprint.");
  }
  return fingerprint;
}

export function assertTlsPrivateKey(certificate: string, privateKey: string): void {
  if (!new X509Certificate(certificate).checkPrivateKey(createPrivateKey(privateKey))) {
    throw new Error("The TLS private key does not match its certificate.");
  }
}
