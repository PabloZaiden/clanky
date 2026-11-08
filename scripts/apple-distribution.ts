import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
