import { X509Certificate } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createAppleDistributionCommands, createAppStoreConnectClient } from "./apple-distribution";
import { prepareAppStoreVersion, submitAppStoreVersion } from "./ios-app-store";
import { verifyAppleFrontend } from "./verify-apple-frontend";

const [tag, mode, ...extra] = process.argv.slice(2);
const version = tag?.match(/^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)?.[1];
if (!tag || !version || extra.length || (mode !== undefined && mode !== "--app-store")) {
  throw new Error("Usage: bun scripts/ios-testflight.ts vX.Y.Z[-prerelease] [--app-store]");
}
const appStore = mode === "--app-store";
if (appStore && tag !== `v${version}`) throw new Error("App Store publication requires a stable versioned release.");
const frontendVersion = tag.slice(1);
if (process.platform !== "darwin") throw new Error("iOS distribution requires macOS and Xcode.");
const { secret, redact, safe, run, importIdentity } = createAppleDistributionCommands();
const keyId = secret("IOS_APP_STORE_KEY_ID");
const issuer = secret("IOS_APP_STORE_ISSUER_ID");
const privateKey = secret("IOS_APP_STORE_KEY_P8");
const groupName = process.env["IOS_TESTFLIGHT_GROUP"]?.trim();
if (!appStore && !groupName) throw new Error("Missing IOS_TESTFLIGHT_GROUP.");
const client = await createAppStoreConnectClient(keyId, issuer, privateKey, { redact, safe });
const { api, list } = client;
const resourceId = z.object({ id: z.string().min(1) });
const buildSchema = resourceId.extend({
  attributes: z.object({
    version: z.string(), processingState: z.enum(["PROCESSING", "VALID", "FAILED", "INVALID"]),
    buildAudienceType: z.enum(["INTERNAL_ONLY", "APP_STORE_ELIGIBLE"]).nullable(),
    usesNonExemptEncryption: z.boolean().nullable(), expired: z.boolean(),
  }),
});
const groupSchema = resourceId.extend({
  attributes: z.object({ name: z.string(), isInternalGroup: z.boolean(), hasAccessToAllBuilds: z.boolean() }),
});
const profileSchema = z.object({
  UUID: z.string().uuid(), Name: z.string().min(1),
  TeamIdentifier: z.array(z.string().regex(/^[A-Z0-9]{10}$/)).length(1),
  DeveloperCertificates: z.array(z.string().min(1)).length(1),
  Entitlements: z.record(z.string(), z.unknown()), ExpirationDate: z.string(),
  ProvisionedDevices: z.array(z.string()).optional(), ProvisionsAllDevices: z.boolean().optional(),
});
const work = await mkdtemp(join(process.env["RUNNER_TEMP"] ?? "/tmp", "clanky-ios-testflight-"));
await chmod(work, 0o700);
const keychain = join(work, "signing.keychain-db");
let originalSearchList: string[] | undefined;
let installedProfile: string | undefined;
let ownsProfile = false;
let profileBytes: Buffer | undefined;

async function publish() {
  const sourceRevision = (await run(["git", "rev-parse", "HEAD"], true)).trim();
  const expectedSource = appStore ? process.env["IOS_SOURCE_REVISION"] : process.env["GITHUB_SHA"];
  if (appStore && !/^[a-f0-9]{40}$/.test(expectedSource ?? "")) {
    throw new Error("App Store publication requires an exact IOS_SOURCE_REVISION.");
  }
  if (expectedSource && sourceRevision !== expectedSource) {
    throw new Error("The checked-out iOS source does not match the selected publication source.");
  }
  const native: string[] = ["-project", "native/Clanky.xcodeproj", "-scheme", "Clanky-iOS",
    "-configuration", "Release", "-destination", "generic/platform=iOS"];
  const settings = z.array(z.object({
    target: z.string(),
    buildSettings: z.object({ PRODUCT_BUNDLE_IDENTIFIER: z.string(), PRODUCT_NAME: z.string() }),
  })).parse(JSON.parse(await run(["xcodebuild", "-showBuildSettings", "-json", ...native, "CODE_SIGNING_ALLOWED=NO"], true)));
  const target = settings.filter((setting) => setting.target === "Clanky-iOS");
  if (target.length !== 1 || !target[0]) throw new Error("Expected exactly one Clanky-iOS build target.");
  const bundleId = target[0].buildSettings.PRODUCT_BUNDLE_IDENTIFIER;
  const product = target[0].buildSettings.PRODUCT_NAME;
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId) || !/^[A-Za-z0-9._-]+$/.test(product)) {
    throw new Error("Invalid iOS bundle identifier or product name.");
  }
  const encoded = secret("IOS_PROVISIONING_PROFILE_BASE64").replace(/\s/g, "");
  profileBytes = Buffer.from(encoded, "base64");
  if (!profileBytes.length || profileBytes.toString("base64") !== encoded) {
    throw new Error("Invalid provisioning profile Base64.");
  }
  const profilePath = join(work, "profile.mobileprovision");
  await writeFile(profilePath, profileBytes, { mode: 0o600 });
  const decoded = join(work, "decoded-profile.plist");
  await writeFile(decoded, await run(["security", "cms", "-D", "-i", profilePath], true), { mode: 0o600 });
  const profile = profileSchema.parse(JSON.parse(await run(["python3", "-c", `
import base64, datetime, json, plistlib, sys
with open(sys.argv[1], "rb") as stream:
    p = plistlib.load(stream)
p["DeveloperCertificates"] = [base64.b64encode(c).decode() for c in p["DeveloperCertificates"]]
p["ExpirationDate"] = p["ExpirationDate"].replace(tzinfo=datetime.timezone.utc).isoformat()
keys = ["UUID", "Name", "TeamIdentifier", "DeveloperCertificates", "Entitlements",
        "ExpirationDate", "ProvisionedDevices", "ProvisionsAllDevices"]
print(json.dumps({k: p[k] for k in keys if k in p}))
`, decoded], true)));
  const team = profile.TeamIdentifier[0]!;
  const appIdentifier = `${team}.${bundleId}`;
  const expiration = Date.parse(profile.ExpirationDate);
  if (!Number.isFinite(expiration) || expiration <= Date.now() || profile.ProvisionedDevices !== undefined
    || profile.ProvisionsAllDevices === true || profile.Entitlements["get-task-allow"] !== false
    || profile.Entitlements["beta-reports-active"] !== true
    || profile.Entitlements["application-identifier"] !== appIdentifier) {
    throw new Error("The profile must be unexpired App Store Connect distribution for the actual iOS app/team.");
  }
  const certificate = new X509Certificate(Buffer.from(profile.DeveloperCertificates[0]!, "base64"));
  if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error("The iOS Distribution certificate is not currently valid.");
  }
  const identity = certificate.fingerprint.replaceAll(":", "");
  const apps = await list("/v1/apps", resourceId.extend({
    attributes: z.object({ name: z.string(), bundleId: z.string() }),
  }), { "filter[bundleId]": bundleId });
  if (apps.length !== 1 || !apps[0]) throw new Error(`Expected one existing App Store Connect app for ${bundleId}.`);
  const app = apps[0];
  const draftId = appStore ? await prepareAppStoreVersion(client, app.id, version!) : undefined;
  let group: z.infer<typeof groupSchema> | undefined;
  if (!appStore) {
    const groups = (await list(`/v1/apps/${app.id}/betaGroups`, groupSchema))
      .filter((group) => group.attributes.name === groupName);
    if (groups.length !== 1 || !groups[0] || !groups[0].attributes.isInternalGroup
      || !groups[0].attributes.hasAccessToAllBuilds) {
      throw new Error(`Expected the existing internal-only ${groupName} group with automatic distribution enabled.`);
    }
    group = groups[0];
    const testers = await list(`/v1/betaGroups/${group.id}/betaTesters`, resourceId);
    if (!testers.length) throw new Error("The internal group has no testers.");
  }
  const filters = { "filter[app]": app.id, "filter[preReleaseVersion.version]": version!,
    "filter[preReleaseVersion.platform]": "IOS" };
  const previous = await list("/v1/builds", buildSchema, filters);
  let greatest = 0;
  for (const build of previous) {
    if (!/^[1-9]\d{0,3}(?:\.\d{1,2}){0,2}$/.test(build.attributes.version)) {
      throw new Error(`Cannot safely increment the existing Apple build number ${build.attributes.version}.`);
    }
    greatest = Math.max(greatest, Number(build.attributes.version.split(".")[0]));
  }
  const buildNumber = String(greatest + 1);
  if (greatest >= 9999) throw new Error("This marketing version has exhausted Apple's four-digit major build component.");
  console.error(`Preparing iOS ${version} (${buildNumber}) from ${sourceRevision} for ${appStore ? "App Store review and automatic release" : "internal TestFlight"}.`);
  originalSearchList = (await run(["security", "list-keychains", "-d", "user"], true))
    .split("\n").map((line) => line.trim()).filter(Boolean).map((line) => z.string().parse(JSON.parse(line)));
  await importIdentity(keychain, "IOS");
  await run(["security", "list-keychains", "-d", "user", "-s", keychain, ...originalSearchList]);
  const identities = await run(["security", "find-identity", "-v", "-p", "codesigning", keychain]);
  const matches = [...identities.matchAll(/^\s*\d+\)\s+([A-F0-9]{40})\s+"Apple Distribution:/gm)];
  if (matches.length !== 1 || matches[0]?.[1] !== identity) {
    throw new Error("Exactly the profile's valid Apple Distribution identity must be available in the CI keychain.");
  }
  installedProfile = join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles", `${profile.UUID}.mobileprovision`);
  await mkdir(dirname(installedProfile), { recursive: true });
  if (await Bun.file(installedProfile).exists()) {
    if (!(await readFile(installedProfile)).equals(profileBytes)) throw new Error("Refusing to replace an existing provisioning profile.");
  } else {
    const handle = await open(installedProfile, "wx", 0o600);
    ownsProfile = true;
    try { await handle.writeFile(profileBytes); } finally { await handle.close(); }
  }
  await run([process.execPath, "scripts/build-apple.ts", "assets", "--frontend-version", frontendVersion]);
  const archive = join(work, `${product}.xcarchive`);
  await run(["xcodebuild", "-quiet", ...native, "-derivedDataPath", join(work, "build"),
    "-archivePath", archive, "ARCHS=arm64", "CODE_SIGN_STYLE=Manual",
    `DEVELOPMENT_TEAM=${team}`, `CODE_SIGN_IDENTITY=${identity}`,
    `PROVISIONING_PROFILE_SPECIFIER=${profile.UUID}`, `OTHER_CODE_SIGN_FLAGS=--keychain ${keychain}`,
    `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${buildNumber}`,
    "GENERATE_INFOPLIST_FILE=YES", "INFOPLIST_KEY_ITSAppUsesNonExemptEncryption=NO", "archive"]);

  async function verify(appPath: string) {
    await run(["codesign", "--verify", "--deep", "--strict", appPath]);
    const info = z.object({
      CFBundleIdentifier: z.literal(bundleId), CFBundleShortVersionString: z.literal(version!),
      CFBundleVersion: z.literal(buildNumber), CFBundleExecutable: z.string().regex(/^[A-Za-z0-9._-]+$/),
      CFBundleSupportedPlatforms: z.tuple([z.literal("iPhoneOS")]), ITSAppUsesNonExemptEncryption: z.literal(false),
    }).parse(JSON.parse(await run(["plutil", "-convert", "json", "-o", "-", join(appPath, "Info.plist")], true)));
    await run([process.execPath, "scripts/verify-ios-settings.ts", appPath]);
    await verifyAppleFrontend(join(appPath, "Web"), sourceRevision, frontendVersion);
    if ((await run(["lipo", "-archs", join(appPath, info.CFBundleExecutable)], true)).trim() !== "arm64") {
      throw new Error("The distribution app must contain exactly the arm64 device architecture.");
    }
    if (!(await readFile(join(appPath, "embedded.mobileprovision"))).equals(profileBytes!)) {
      throw new Error("The signed app embeds a different provisioning profile.");
    }
    const prefix = join(work, "verified-certificate-");
    await run(["codesign", "-d", `--extract-certificates=${prefix}`, appPath]);
    if (new X509Certificate(await readFile(`${prefix}0`)).fingerprint.replaceAll(":", "") !== identity) {
      throw new Error("The signed app uses a different Distribution certificate.");
    }
    const entitlementPath = join(work, "verified-entitlements.plist");
    await writeFile(entitlementPath, await run(["codesign", "-d", "--entitlements", "-", "--xml", appPath], true), { mode: 0o600 });
    const entitlements = z.record(z.string(), z.unknown()).parse(
      JSON.parse(await run(["plutil", "-convert", "json", "-o", "-", entitlementPath], true)));
    if (entitlements["application-identifier"] !== appIdentifier || entitlements["get-task-allow"] !== false
      || entitlements["beta-reports-active"] !== true
      || entitlements["com.apple.developer.team-identifier"] !== team) {
      throw new Error("Invalid App Store Connect distribution entitlements.");
    }
    function permitted(actual: unknown, allowed: unknown): boolean {
      if (typeof actual === "string" && typeof allowed === "string") {
        return allowed.endsWith("*") ? actual.startsWith(allowed.slice(0, -1)) : actual === allowed;
      }
      if (Array.isArray(actual) && Array.isArray(allowed)) {
        return actual.every((value) => allowed.some((candidate) => permitted(value, candidate)));
      }
      return actual === allowed;
    }
    if (Object.entries(entitlements).some(([name, value]) => !permitted(value, profile.Entitlements[name]))) {
      throw new Error("The signed app requests entitlements not authorized by the profile.");
    }
  }
  await verify(join(archive, "Products/Applications", `${product}.app`));
  const options = join(work, "ExportOptions.plist");
  await writeFile(options, JSON.stringify({
    method: "app-store-connect", destination: "export", teamID: team, signingStyle: "manual",
    signingCertificate: identity, provisioningProfiles: { [bundleId]: profile.UUID },
    manageAppVersionAndBuildNumber: false, ...(!appStore && { testFlightInternalTestingOnly: true }),
  }), { mode: 0o600 });
  await run(["plutil", "-convert", "xml1", options]);
  await chmod(options, 0o600);
  const exported = join(work, "export");
  await run(["xcodebuild", "-quiet", "-exportArchive", "-archivePath", archive,
    "-exportPath", exported, "-exportOptionsPlist", options]);
  const files = (await readdir(exported)).filter((file) => file.endsWith(".ipa"));
  if (files.length !== 1 || !files[0]) throw new Error("Expected exactly one exported App Store Connect IPA.");
  const ipa = join(exported, files[0]);
  const extracted = join(work, "verified-ipa");
  await run(["ditto", "-x", "-k", ipa, extracted]);
  await verify(join(extracted, "Payload", `${product}.app`));
  const keys = join(work, "private_keys");
  await mkdir(keys, { mode: 0o700 });
  await writeFile(join(keys, `AuthKey_${keyId}.p8`), `${privateKey}\n`, { mode: 0o600 });
  console.error(`Uploading verified iOS ${version} (${buildNumber}); ${appStore ? "App Review submission and automatic release will follow processing" : "no external distribution or App Store submission"}.`);
  await run(["xcrun", "altool", "--upload-package", ipa, "--api-key", keyId, "--api-issuer", issuer],
    false, { ...process.env, API_PRIVATE_KEYS_DIR: keys });
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const builds = await list("/v1/builds", buildSchema, { ...filters, "filter[version]": buildNumber });
    if (builds.length > 1) throw new Error("Apple returned multiple builds for the same marketing/build version.");
    const build = builds[0];
    if (build && build.attributes.version !== buildNumber) {
      throw new Error("Apple returned a different build number than the uploaded artifact.");
    }
    if (build?.attributes.processingState === "FAILED" || build?.attributes.processingState === "INVALID") {
      throw new Error(`Apple rejected build ${build.id}: ${build.attributes.processingState}.`);
    }
    if (build?.attributes.processingState === "VALID") {
      const audience = appStore ? "APP_STORE_ELIGIBLE" : "INTERNAL_ONLY";
      if (build.attributes.buildAudienceType !== audience
        || build.attributes.usesNonExemptEncryption !== false || build.attributes.expired) {
        throw new Error(`Apple did not confirm an unexpired ${audience} build with the declared OS-only encryption.`);
      }
      const prerelease = z.object({ data: resourceId.extend({
        attributes: z.object({ version: z.literal(version!), platform: z.literal("IOS") }),
      }) }).parse(await api(`/v1/builds/${build.id}/preReleaseVersion`));
      if (!prerelease.data.id) throw new Error("Missing processed iOS prerelease version.");
      if (appStore) {
        if (!draftId) throw new Error("Missing prepared App Store version.");
        const review = await submitAppStoreVersion(client, app.id, version!, draftId, build.id);
        return { appId: app.id, bundleId, releaseTag: tag, version, frontendVersion, buildNumber,
          buildId: build.id, sourceRevision, configuration: "Release", architecture: "arm64",
          internalOnly: false, processingState: "VALID", buildAudienceType: audience, ...review };
      }
      if (!group) throw new Error("Missing verified internal TestFlight group.");
      const detail = z.object({ data: resourceId.extend({
        attributes: z.object({ internalBuildState: z.string() }),
      }) }).parse(await api(`/v1/builds/${build.id}/buildBetaDetail`));
      if (["READY_FOR_BETA_TESTING", "IN_BETA_TESTING"].includes(detail.data.attributes.internalBuildState)) {
        const currentGroup = z.object({ data: groupSchema }).parse(await api(`/v1/betaGroups/${group.id}`)).data;
        if (currentGroup.attributes.name !== groupName
          || !currentGroup.attributes.isInternalGroup || !currentGroup.attributes.hasAccessToAllBuilds) {
          throw new Error("The selected automatic internal TestFlight group changed or is no longer available.");
        }
        const currentTesters = await list(`/v1/betaGroups/${group.id}/betaTesters`, resourceId);
        if (!currentTesters.length) throw new Error("The internal group has no testers.");
        return { appId: app.id, appName: app.attributes.name, bundleId, releaseTag: tag, version, frontendVersion,
          buildNumber, buildId: build.id, sourceRevision, configuration: "Release", architecture: "arm64",
          signingCertificateSHA1: identity, teamId: team, profileUUID: profile.UUID,
          internalOnly: true, internalGroupId: group.id, internalGroupName: groupName,
          internalTesterCount: currentTesters.length, processingState: "VALID",
          internalBuildState: detail.data.attributes.internalBuildState };
      }
      if (["EXPIRED", "INVALID", "MISSING_EXPORT_COMPLIANCE"].includes(detail.data.attributes.internalBuildState)) {
        throw new Error(`Internal TestFlight is unavailable: ${detail.data.attributes.internalBuildState}.`);
      }
    }
    await Bun.sleep(15_000);
  }
  throw new Error(appStore
    ? `Apple did not finish processing iOS ${version} (${buildNumber}) for App Store review within the deadline. Inspect the build before rerunning.`
    : `Apple did not make iOS ${version} (${buildNumber}) available to ${groupName} within the processing deadline.`);
}

let result: Awaited<ReturnType<typeof publish>> | undefined;
let failure: unknown;
try {
  result = await publish();
} catch (error) {
  failure = error;
} finally {
  const cleanup: (() => Promise<unknown>)[] = [
    async () => {
      if (originalSearchList) await run(["security", "list-keychains", "-d", "user", "-s", ...originalSearchList]);
    },
    async () => { if (await Bun.file(keychain).exists()) await run(["security", "delete-keychain", keychain]); },
    async () => {
      if (ownsProfile && installedProfile) {
        if (!(await readFile(installedProfile)).equals(profileBytes!)) throw new Error("The owned profile changed; refusing to delete it.");
        await rm(installedProfile);
      }
    },
    async () => { await rm(work, { recursive: true, force: true }); },
  ];
  for (const action of cleanup) {
    try { await action(); } catch (error) {
      failure = failure ? new AggregateError([failure, error], "TestFlight publication and cleanup failed.") : error;
    }
  }
}
if (failure) throw failure;
console.log(JSON.stringify(result));
