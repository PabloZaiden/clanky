import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const [app, ...extra] = process.argv.slice(2);
if (!app?.trim() || extra.length) throw new Error("Usage: bun scripts/verify-ios-settings.ts /path/to/Clanky.app");
const settings = join(app, "Settings.bundle", "Root.plist");
if (!(await readFile(settings)).equals(await readFile("native/Configuration/Settings.bundle/Root.plist"))) {
  throw new Error("The iOS Settings bundle does not match the checked-out source.");
}
const child = Bun.spawn(["python3", "-c", `
import json, plistlib, sys
with open(sys.argv[1], "rb") as stream:
    print(json.dumps(plistlib.load(stream)))
`, settings], { stdout: "pipe", stderr: "inherit" });
const text = await new Response(child.stdout).text();
if (await child.exited !== 0) throw new Error("Unable to read the iOS Settings bundle.");
const root = z.object({ PreferenceSpecifiers: z.array(z.record(z.string(), z.unknown())) }).parse(JSON.parse(text));
const toggles = root.PreferenceSpecifiers.filter(row => row["Key"] === "useLatestFrontend");
z.tuple([z.object({
  Type: z.literal("PSToggleSwitchSpecifier"), Key: z.literal("useLatestFrontend"),
  DefaultValue: z.literal(false), Title: z.string().min(1),
})]).parse(toggles);
