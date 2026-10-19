/**
 * CLI-local HTTPS listener credentials, independent of upstream TLS trust.
 */

import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { chmod, link, mkdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { resolveAppDataDir } from "@pablozaiden/webapp/server";
import { z } from "zod";
import { createSelfSignedTlsIdentity } from "../lib/self-signed-tls";

const IdentitySchema = z.object({
  certificate: z.string().min(1),
  privateKey: z.string().min(1),
});

function validateIdentity(identity: z.infer<typeof IdentitySchema>, hostnames: string[]): void {
  const certificate = new X509Certificate(identity.certificate);
  if (!certificate.checkPrivateKey(createPrivateKey(identity.privateKey))) {
    throw new Error("Preview TLS private key does not match its certificate");
  }
  if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error("Preview TLS certificate is not currently valid; supply a valid --tls-cert and --tls-key");
  }
  for (const hostname of hostnames) {
    if (!(isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname))) {
      throw new Error(`Preview TLS certificate does not cover ${hostname}`);
    }
  }
}

export async function getPreviewListenerTls(options: {
  host: string;
  tlsCert?: string;
  tlsKey?: string;
  warn: (message: string) => void;
}): Promise<Bun.TLSOptions> {
  if (options.tlsCert && options.tlsKey) {
    return {
      cert: await Bun.file(options.tlsCert).text(),
      key: await Bun.file(options.tlsKey).text(),
    };
  }
  const host = options.host.replace(/^\[|\]$/g, "");
  const hostnames = [...new Set(["localhost", "127.0.0.1", "::1", host])].sort();
  const directory = join(resolveAppDataDir({
    envPrefix: "CLANKY",
    appDirectoryName: ".clanky",
  }), "preview-tls");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const id = createHash("sha256").update(hostnames.join("\n")).digest("hex");
  const path = join(directory, `${id}.json`);
  if (!(await Bun.file(path).exists())) {
    const identity = await createSelfSignedTlsIdentity({
      name: "CN=Clanky Local Preview",
      hostnames,
      notBefore: new Date(Date.now() - 24 * 60 * 60 * 1000),
      notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(identity)}\n`, { mode: 0o600, flag: "wx" });
      try {
        // Concurrent previews must reuse the first complete identity, not replace it.
        await link(temporaryPath, path);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
  let identity: z.infer<typeof IdentitySchema>;
  try {
    await chmod(path, 0o600);
    identity = IdentitySchema.parse(JSON.parse(await Bun.file(path).text()));
    validateIdentity(identity, hostnames);
  } catch (error) {
    throw new Error(`Unable to load local preview TLS identity at ${path}`, { cause: error });
  }
  options.warn("Warning: the local preview uses a self-signed certificate. Accept it in your browser or use --tls-cert and --tls-key with a trusted development certificate.");
  return { cert: identity.certificate, key: identity.privateKey };
}
