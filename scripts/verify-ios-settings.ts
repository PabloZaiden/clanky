import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const [app, mode, ...extra] = process.argv.slice(2);
if (!app?.trim() || extra.length || (mode !== undefined && mode !== "--app-store")) {
  throw new Error("Usage: bun scripts/verify-ios-settings.ts /path/to/Clanky.app [--app-store]");
}
const appStore = mode === "--app-store";
const settings = join(app, "Settings.bundle", "Root.plist");
const privacy = join(app, "PrivacyInfo.xcprivacy");
if (!(await readFile(privacy)).equals(await readFile("native/Shared/PrivacyInfo.xcprivacy"))) {
  throw new Error("The iOS privacy manifest does not match the checked-out source.");
}
if (appStore) {
  if ((await readdir(app)).includes("Settings.bundle")) {
    throw new Error("The public App Store app must not contain the frontend Settings bundle.");
  }
} else if (!(await readFile(settings)).equals(await readFile("native/Configuration/Settings.bundle/Root.plist"))) {
  throw new Error("The iOS Settings bundle does not match the checked-out source.");
}
const child = Bun.spawn(["python3", "-c", `
import json, plistlib, sys
values = []
for path in sys.argv[1:]:
    with open(path, "rb") as stream:
        values.append(plistlib.load(stream))
print(json.dumps(values))
`, join(app, "Info.plist"), privacy, ...(!appStore ? [settings] : [])], { stdout: "pipe", stderr: "inherit" });
const text = await new Response(child.stdout).text();
if (await child.exited !== 0) throw new Error("Unable to read the iOS bundle metadata, Settings or privacy manifest.");
const [, , root] = z.tuple([
  z.object({ ClankyFrontendUpdates: z.literal(appStore ? "disabled" : "enabled") }),
  z.object({
    NSPrivacyTracking: z.literal(false),
    NSPrivacyTrackingDomains: z.tuple([]),
    NSPrivacyCollectedDataTypes: z.tuple([]),
    NSPrivacyAccessedAPITypes: z.tuple([z.object({
      NSPrivacyAccessedAPIType: z.literal("NSPrivacyAccessedAPICategoryUserDefaults"),
      NSPrivacyAccessedAPITypeReasons: z.tuple([z.literal("CA92.1")]),
    })]),
  }),
  z.object({ PreferenceSpecifiers: z.array(z.record(z.string(), z.unknown())) }).optional(),
]).parse(JSON.parse(text));
if (!appStore) {
  if (!root) throw new Error("The iOS frontend Settings are missing.");
  const toggles = root.PreferenceSpecifiers.filter(row => row["Key"] === "useLatestFrontend");
  z.tuple([z.object({
    Type: z.literal("PSToggleSwitchSpecifier"), Key: z.literal("useLatestFrontend"),
    DefaultValue: z.literal(false), Title: z.string().min(1),
  })]).parse(toggles);
}
