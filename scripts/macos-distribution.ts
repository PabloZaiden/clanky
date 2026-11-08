import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { createAppleDistributionCommands, validAppleApiIdentifiers } from "./apple-distribution";

const args = process.argv.slice(2);
const notarize = args.includes("--notarize");
if (args.some((arg) => arg.startsWith("--") && arg !== "--notarize")) {
  throw new Error("Only --notarize and artifact paths are supported.");
}
if (process.platform !== "darwin") throw new Error("Mac distribution requires macOS.");
const paths = args.filter((arg) => arg !== "--notarize");
const targets = z.array(z.string().min(1)).min(1).parse(
  paths.length ? paths : JSON.parse(process.env["MACOS_ARTIFACT_PATHS_JSON"] ?? "null"),
).map((path) => resolve(path));
if (new Set(targets.map((path) => basename(path))).size !== targets.length) {
  throw new Error("Mac distribution artifacts must have distinct filenames.");
}
const apps = targets.filter((path) => path.endsWith(".app"));
if (apps.length && (apps.length !== 1 || targets.length !== 1)) {
  throw new Error("Submit one app or a batch of standalone binaries, not a mixture.");
}

const { secret, safe, execute, run, importIdentity } = createAppleDistributionCommands();
const keyId = notarize ? secret("MACOS_NOTARIZATION_KEY_ID") : "";
const issuerId = notarize ? secret("MACOS_NOTARIZATION_ISSUER_ID") : "";
const apiKey = notarize ? secret("MACOS_NOTARIZATION_KEY_P8") : "";
if (notarize && !validAppleApiIdentifiers(keyId, issuerId)) {
  throw new Error("Invalid notarization key ID or issuer ID.");
}

const work = await mkdtemp(join(process.env["RUNNER_TEMP"] ?? "/tmp", "clanky-macos-distribution-"));
let keychain = process.env["MACOS_SIGNING_KEYCHAIN"];
const ownsKeychain = !keychain;
const submissionSchema = z.object({ id: z.string().uuid(), status: z.string() });
const logSchema = z.object({
  status: z.string(),
  issues: z.array(z.object({
    severity: z.string(), message: z.string(), path: z.string().nullable().optional(),
  })).nullable().optional(),
  ticketContents: z.array(z.object({ cdhash: z.string() })).nullable().optional(),
});

async function machOFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const magic = new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe",
    "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await machOFiles(path));
    } else if (entry.isFile()) {
      const header = Buffer.from(await Bun.file(path).slice(0, 4).arrayBuffer()).toString("hex");
      if (magic.has(header)) files.push(path);
    } else {
      throw new Error(`Unsupported app bundle entry: ${path}.`);
    }
  }
  return files;
}

async function distribute() {
  for (const target of targets) {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !(target.endsWith(".app") ? stat.isDirectory() : stat.isFile())) {
      throw new Error(`Invalid Mac distribution artifact: ${target}.`);
    }
  }
  if (!keychain) {
    keychain = join(work, "signing.keychain-db");
    await importIdentity(keychain, "MACOS");
  }
  const signingKeychain = keychain;
  if (!signingKeychain) throw new Error("Missing prepared signing keychain.");
  const identities = await run(["security", "find-identity", "-v", "-p", "codesigning", signingKeychain]);
  const matches = [...identities.matchAll(/^\s*\d+\)\s+([A-F0-9]{40})\s+"Developer ID Application:/gm)];
  const selectedIdentity = matches.length === 1 ? matches[0]?.[1] : undefined;
  if (!selectedIdentity) throw new Error("Exactly one valid Developer ID Application identity is required.");
  const identity = selectedIdentity;
  const emptyEntitlements = join(work, "library.entitlements");
  const appEntitlements = join(work, "app.entitlements");
  const bunEntitlements = join(work, "controller.entitlements");
  const plist = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${body}</dict></plist>\n`;
  await writeFile(emptyEntitlements, plist(""), { mode: 0o600 });
  const appPermissions = {
    "com.apple.security.device.audio-input": true,
    "com.apple.security.device.camera": true,
  };
  await writeFile(appEntitlements, plist(Object.keys(appPermissions)
    .map((key) => `<key>${key}</key><true/>`).join("")), { mode: 0o600 });
  await writeFile(bunEntitlements, plist("<key>com.apple.security.cs.allow-jit</key><true/>"), { mode: 0o600 });
  let teamId: string | undefined;
  let verificationIndex = 0;
  const hashes = new Map<string, string>();
  const signed: { path: string; bun: boolean }[] = [];
  async function verify(target: string, bun: boolean) {
    await run(["codesign", "--verify", "--strict", "--verbose=2", target]);
    const details = await run(["codesign", "-d", "--verbose=4", target]);
    const team = details.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
    if (!team || (teamId && team !== teamId) || !details.includes("Authority=Developer ID Application:")
      || !/^Timestamp=/m.test(details) || !/^CodeDirectory .*flags=.*runtime/m.test(details)) {
      throw new Error(`Invalid Developer ID, timestamp or Hardened Runtime signature: ${target}.`);
    }
    teamId = team;
    const cdhash = details.match(/^CDHash=([a-f0-9]{40})$/im)?.[1]?.toLowerCase();
    if (!cdhash || (hashes.has(target) && hashes.get(target) !== cdhash)) {
      throw new Error(`Missing or changed signed code hash: ${target}.`);
    }
    hashes.set(target, cdhash);
    const prefix = join(work, `certificate-${verificationIndex++}-`);
    await run(["codesign", "-d", `--extract-certificates=${prefix}`, target]);
    const fingerprint = await run(["openssl", "x509", "-inform", "DER", "-in", `${prefix}0`, "-noout", "-fingerprint", "-sha1"]);
    const actual = fingerprint.split("=")[1]?.trim().replaceAll(":", "").toUpperCase();
    if (actual !== identity) throw new Error(`Unexpected signing certificate: ${target}.`);
    const expected = bun ? { "com.apple.security.cs.allow-jit": true }
      : target.endsWith(".app") ? appPermissions : {};
    const xml = await run(["codesign", "-d", "--entitlements", "-", "--xml", target], true);
    if (!xml.trim()) {
      if (Object.keys(expected).length) throw new Error(`Missing required distribution entitlements: ${target}.`);
      return;
    }
    const entitlementPath = join(work, `verified-${verificationIndex}.plist`);
    await writeFile(entitlementPath, xml);
    const values: unknown = JSON.parse(await run(["plutil", "-convert", "json", "-o", "-", entitlementPath]));
    const entitlements = z.record(z.string(), z.boolean()).parse(values);
    if (Object.keys(entitlements).length !== Object.keys(expected).length
      || Object.entries(expected).some(([key, value]) => entitlements[key] !== value)) {
      throw new Error(`Unexpected distribution entitlements: ${target}.`);
    }
  }
  async function sign(target: string, bun: boolean) {
    await run(["codesign", "--force", "--sign", identity, "--keychain", signingKeychain,
      "--timestamp", "--options", "runtime", "--entitlements",
      bun ? bunEntitlements : target.endsWith(".app") ? appEntitlements : emptyEntitlements, target]);
    await verify(target, bun);
    signed.push({ path: target, bun });
  }
  for (const target of targets) {
    if (target.endsWith(".app")) {
      const controller = join(target, "Contents/Helpers/clanky");
      if (!(await lstat(controller)).isFile()) throw new Error("Missing bundled Mac controller.");
      const main = join(target, "Contents/MacOS/Clanky");
      const code = await machOFiles(target);
      if (!code.includes(controller) || !code.includes(main)) {
        throw new Error("Missing native Mac executable or bundled controller Mach-O code.");
      }
      for (const path of code) {
        if (path !== main) await sign(path, path === controller);
      }
      await sign(target, false);
      await run(["codesign", "--verify", "--deep", "--strict", target]);
    } else {
      await sign(target, true);
    }
  }
  let submissionId: string | undefined;
  let notaryLog: unknown;
  if (notarize) {
    const apiPath = join(work, "notary.p8");
    await writeFile(apiPath, `${apiKey}\n`, { mode: 0o600 });
    const auth = ["--key", apiPath, "--key-id", keyId, "--issuer", issuerId];
    const zip = join(work, "submission.zip");
    if (apps[0]) {
      await run(["ditto", "-c", "-k", "--keepParent", apps[0], zip]);
    } else {
      const payload = join(work, "payload");
      await mkdir(payload);
      for (const target of targets) await copyFile(target, join(payload, basename(target)));
      await run(["ditto", "-c", "-k", "--keepParent", payload, zip]);
    }
    const response = await execute(["xcrun", "notarytool", "submit", zip, ...auth,
      "--wait", "--timeout", "20m", "--output-format", "json"]);
    let data: unknown;
    try {
      data = JSON.parse(response.stdout);
    } catch {
      throw new Error(`Notary submission failed (${response.code}): ${safe(response.stderr)}`);
    }
    const submission = submissionSchema.parse(data);
    submissionId = submission.id;
    const logPath = join(work, "notary-log.json");
    await run(["xcrun", "notarytool", "log", submission.id, logPath, ...auth]);
    notaryLog = JSON.parse(await readFile(logPath, "utf8"));
    const log = logSchema.parse(notaryLog);
    if (response.code !== 0 || submission.status !== "Accepted" || log.status !== "Accepted") {
      throw new Error(`Apple did not accept submission ${submission.id}: ${JSON.stringify(log)}.`);
    }
    const tickets = new Set((log.ticketContents ?? []).map((ticket) => ticket.cdhash.toLowerCase()));
    if ([...hashes.values()].some((hash) => !tickets.has(hash))) {
      throw new Error(`Apple's ticket does not cover every distributed executable: ${submission.id}.`);
    }
    for (const issue of log.issues ?? []) {
      if (issue.severity === "error") throw new Error(`Apple notarization error: ${issue.message}.`);
      console.warn(`Apple notarization ${issue.severity}: ${issue.path ?? "artifact"}: ${issue.message}`);
    }
    if (apps[0]) {
      await run(["xcrun", "stapler", "staple", apps[0]]);
      await run(["xcrun", "stapler", "validate", apps[0]]);
      await run(["spctl", "--assess", "--type", "execute", "--verbose=2", apps[0]]);
    }
    for (const target of signed) await verify(target.path, target.bun);
    for (const app of apps) await run(["codesign", "--verify", "--deep", "--strict", app]);
  }
  return {
    distributionSigned: true, notarized: notarize, signingCertificateSHA1: identity,
    teamId, notarizationSubmissionId: submissionId, notaryLog, artifacts: targets,
    stapled: notarize && apps.length === 1, codeDirectoryHashes: Object.fromEntries(hashes),
  };
}

let result: Awaited<ReturnType<typeof distribute>> | undefined;
let failure: unknown;
try {
  result = await distribute();
} catch (error) {
  failure = error;
} finally {
  try {
    if (ownsKeychain && keychain && await Bun.file(keychain).exists()) {
      await run(["security", "delete-keychain", keychain]);
    }
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "Distribution and keychain cleanup failed.") : error;
  } finally {
    try {
      await rm(work, { recursive: true, force: true });
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], "Distribution and private-file cleanup failed.") : error;
    }
  }
}
if (failure) throw failure;
console.log(JSON.stringify(result));
