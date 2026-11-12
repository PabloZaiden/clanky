import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";

export async function createAppStoreConnectClient(
  keyId: string, issuer: string, privateKey: string,
  redactions: { redact(value: string): void; safe(value: string): string },
) {
  if (!validAppleApiIdentifiers(keyId, issuer)) throw new Error("Invalid App Store Connect API key/issuer identifiers.");
  const key = await importPKCS8(privateKey, "ES256");
  const origin = "https://api.appstoreconnect.apple.com";
  async function api(path: string, method = "GET", data?: unknown): Promise<unknown> {
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/v1/")) {
      throw new Error("Unexpected App Store Connect pagination URL.");
    }
    const token = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: keyId, typ: "JWT" })
      .setIssuer(issuer).setAudience("appstoreconnect-v1").setIssuedAt().setExpirationTime("10m").sign(key);
    redactions.redact(token);
    const response = await fetch(url, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`App Store Connect ${method} ${url.pathname} failed (${response.status}): ${redactions.safe(text).slice(0, 4000)}`);
    }
    if (!text && method === "GET") throw new Error(`Empty App Store Connect response: ${url.pathname}.`);
    return text ? JSON.parse(text) : null;
  }
  async function list<T>(path: string, schema: z.ZodType<T>, filters: Record<string, string> = {}): Promise<T[]> {
    const rows: T[] = [];
    const seen = new Set<string>();
    let next: string | null = `${path}?${new URLSearchParams({ ...filters, limit: "200" })}`;
    while (next) {
      if (seen.has(next)) throw new Error("Repeated App Store Connect pagination URL.");
      seen.add(next);
      const page = z.object({
        data: z.array(schema), links: z.object({ next: z.string().nullable().optional() }),
      }).parse(await api(next));
      rows.push(...page.data);
      next = page.links.next ?? null;
    }
    return rows;
  }
  return { api, list };
}

export type AppStoreConnectClient = Awaited<ReturnType<typeof createAppStoreConnectClient>>;

export function validAppleApiIdentifiers(keyId: string, issuer: string): boolean {
  return /^[A-Z0-9]{10}$/.test(keyId) && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(issuer);
}

export function createAppleDistributionCommands() {
  const redactions: string[] = [];
  function redact(value: string) {
    redactions.push(value);
  }
  function secret(name: string, preserveWhitespace = false): string {
    const raw = process.env[name];
    const value = preserveWhitespace ? raw : raw?.trim();
    if (!value) throw new Error(`Missing ${name}.`);
    redact(value);
    return value;
  }
  function safe(text: string): string {
    return redactions.reduce((result, value) => result.replaceAll(value, "[redacted]"), text);
  }
  async function execute(cmd: [string, ...string[]], env?: NodeJS.ProcessEnv) {
    const child = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  }
  async function run(cmd: [string, ...string[]], stdoutOnly = false, env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await execute(cmd, env);
    if (result.code !== 0) {
      throw new Error(`${basename(cmd[0])} failed (${result.code}): ${safe(result.stderr)}`);
    }
    return stdoutOnly ? result.stdout : result.stdout + result.stderr;
  }
  async function importIdentity(keychain: string, prefix: "MACOS" | "IOS") {
    const encoded = secret(`${prefix}_SIGNING_CERTIFICATE_BASE64`).replace(/\s/g, "");
    const certificate = Buffer.from(encoded, "base64");
    if (!certificate.length || certificate.toString("base64") !== encoded) {
      throw new Error("Invalid signing certificate Base64.");
    }
    const password = secret(`${prefix}_SIGNING_CERTIFICATE_PASSWORD`, true);
    const keychainPassword = randomBytes(32).toString("hex");
    redact(keychainPassword);
    const certificatePath = join(dirname(keychain), "signing.p12");
    await writeFile(certificatePath, certificate, { mode: 0o600 });
    await run(["security", "create-keychain", "-p", keychainPassword, keychain]);
    await run(["security", "set-keychain-settings", "-lut", "21600", keychain]);
    await run(["security", "unlock-keychain", "-p", keychainPassword, keychain]);
    await run(["security", "import", certificatePath, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"]);
    await run(["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain]);
  }
  return { secret, redact, safe, execute, run, importIdentity };
}
