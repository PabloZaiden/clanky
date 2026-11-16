import { lstat, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, posix, relative } from "node:path";
import { z } from "zod";

export const checkoutAccessSchema = z.object({
  hostUid: z.number().int().nonnegative(),
  toolingUid: z.number().int().nonnegative(),
});

type Command = (command: string, args: string[], input?: ReadableStream<Uint8Array>) => Promise<string>;
type AclEntry = { tag: "user" | "group" | "mask" | "other"; qualifier: string; permissions: number };

function mappedId(id: number, mapping: string): number {
  const ranges = mapping.trim().split("\n").map((line) => {
    const values = line.trim().split(/\s+/).map(Number);
    if (values.length !== 3 || values.some((value) => !Number.isSafeInteger(value) || value < 0) || !values[2]) {
      throw new Error("Cannot resolve the rootless container's user namespace mapping.");
    }
    return { inside: values[0]!, outside: values[1]!, count: values[2]! };
  });
  const matches = ranges.filter((range) => id >= range.inside && id - range.inside < range.count);
  if (matches.length !== 1) throw new Error("The tooling user is not uniquely mapped to a provisioning-host identity.");
  return matches[0]!.outside + id - matches[0]!.inside;
}

function parseAcl(lines: string[], prefix: string): AclEntry[] {
  return lines.filter((line) => !line.startsWith("#") && line.startsWith("default:") === Boolean(prefix)).map((line) => {
    const match = /^(user|group|mask|other):(\d*):([r-][w-][x-])(?:\s+#effective:[r-][w-][x-])?$/.exec(line.slice(prefix.length));
    if (!match) throw new Error("Cannot safely interpret the checkout's existing POSIX ACL.");
    const tag = match[1];
    if (tag !== "user" && tag !== "group" && tag !== "mask" && tag !== "other") throw new Error("Invalid checkout ACL entry.");
    const permissions = match[3]!;
    return {
      tag, qualifier: match[2]!,
      permissions: (permissions[0] === "r" ? 4 : 0) | (permissions[1] === "w" ? 2 : 0) | (permissions[2] === "x" ? 1 : 0),
    };
  });
}

function extendAcl(entries: AclEntry[], grants: [number, number][], prefix = ""): string[] {
  for (const tag of ["user", "group", "other"]) {
    if (entries.filter((entry) => entry.tag === tag && !entry.qualifier).length !== 1) {
      throw new Error("The checkout's POSIX ACL is missing a unique base entry.");
    }
  }
  const mask = entries.find((entry) => entry.tag === "mask")?.permissions ?? 7;
  // Preserve other identities' effective access before widening the shared mask.
  const result = entries.filter((entry) => entry.tag !== "mask").map((entry) => ({
    ...entry,
    permissions: entry.tag === "group" || (entry.tag === "user" && entry.qualifier)
      ? entry.permissions & mask : entry.permissions,
  }));
  for (const [uid, permissions] of grants) {
    const existing = result.find((entry) => entry.tag === "user" && entry.qualifier === String(uid));
    if (existing) existing.permissions |= permissions;
    else result.push({ tag: "user", qualifier: String(uid), permissions });
  }
  result.push({
    tag: "mask", qualifier: "",
    permissions: result.filter((entry) => entry.tag === "group" || (entry.tag === "user" && entry.qualifier))
      .reduce((permissions, entry) => permissions | entry.permissions, 0),
  });
  return result.map((entry) => `${prefix}${entry.tag}:${entry.qualifier}:${
    (entry.permissions & 4 ? "r" : "-") + (entry.permissions & 2 ? "w" : "-") + (entry.permissions & 1 ? "x" : "-")
  }`);
}

export async function prepareRootlessCheckoutAccess(
  options: {
    directory: string; workdir: string; containerId: string; remoteUser: string;
    checkoutAccess?: z.infer<typeof checkoutAccessSchema>;
  },
  command: Command,
): Promise<z.infer<typeof checkoutAccessSchema>> {
  if (process.platform !== "linux") {
    throw new Error("Rootless checkout access requires Docker and the checkout on the same Linux provisioning host.");
  }
  const mounts = z.array(z.object({
    Type: z.string(), Source: z.string(), Destination: z.string(), RW: z.boolean(),
  })).parse(JSON.parse(await command("docker", ["inspect", "--format", "{{json .Mounts}}", options.containerId])));
  const mount = mounts.filter((candidate) => {
    const suffix = posix.relative(candidate.Destination, options.workdir);
    return suffix !== ".." && !suffix.startsWith("../") && !posix.isAbsolute(suffix);
  }).sort((left, right) => right.Destination.length - left.Destination.length)[0];
  const directory = await realpath(options.directory);
  if (!mount || mount.Type !== "bind" || !mount.RW || await realpath(mount.Source) !== directory) {
    throw new Error("Rootless checkout access requires a writable bind mount of the selected checkout. Other mounts are not modified.");
  }
  const identity = z.object({
    uid: z.number().int().nonnegative(), uidMap: z.string(), gidMap: z.string(),
    ownerUid: z.number().int().nonnegative(), ownerGid: z.number().int().nonnegative(),
  }).parse(JSON.parse(await command("docker", ["exec", "--user", options.remoteUser, options.containerId, "node", "-e", `
const fs = require("node:fs");
const directory = fs.statSync(process.argv[1]);
process.stdout.write(JSON.stringify({
  uid: process.getuid(), uidMap: fs.readFileSync("/proc/self/uid_map", "utf8"),
  gidMap: fs.readFileSync("/proc/self/gid_map", "utf8"), ownerUid: directory.uid, ownerGid: directory.gid,
}));
`, mount.Destination])));
  const host = userInfo();
  const owner = await lstat(directory);
  if (owner.uid !== host.uid || mappedId(identity.ownerUid, identity.uidMap) !== owner.uid
    || mappedId(identity.ownerGid, identity.gidMap) !== owner.gid) {
    throw new Error("Rootless checkout ownership does not match the provisioning host. Select a checkout owned by the provisioning user; no permissions were changed.");
  }
  const access = { hostUid: host.uid, toolingUid: mappedId(identity.uid, identity.uidMap) };
  if (access.hostUid === access.toolingUid
    || (options.checkoutAccess?.hostUid === access.hostUid && options.checkoutAccess.toolingUid === access.toolingUid)) return access;
  if (!Bun.which("getfacl") || !Bun.which("setfacl")) {
    throw new Error("Rootless Docker requires getfacl and setfacl on the provisioning host. Install the Linux acl package and retry; checkout ownership is not changed.");
  }
  const current = await command("getfacl", ["--recursive", "--physical", "--absolute-names", "--numeric", "--", directory]);
  const prepared: string[] = [];
  for (const block of current.trimEnd().split("\n\n")) {
    const lines = block.split("\n");
    const header = lines.find((line) => line.startsWith("# file: "));
    if (!header) throw new Error("Cannot identify a checkout ACL path.");
    const file = header.slice("# file: ".length).replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    const suffix = relative(directory, file);
    if (suffix === ".." || suffix.startsWith("../") || isAbsolute(suffix)) throw new Error("Refusing to modify an ACL outside the checkout.");
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink()) continue;
    if (metadata.uid !== host.uid || metadata.dev !== owner.dev || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error("Rootless ACL preparation requires checkout files owned by the provisioning user on the checkout filesystem. No ACLs were applied.");
    }
    const entries = parseAcl(lines, "");
    const permissions = entries.find((entry) => entry.tag === "user" && !entry.qualifier)?.permissions;
    if (permissions === undefined) throw new Error("Cannot determine the checkout owner's permissions.");
    prepared.push(header, ...lines.filter((line) => line.startsWith("# flags: ")),
      ...extendAcl(entries, [[access.toolingUid, permissions]]));
    if (metadata.isDirectory()) {
      const defaults = parseAcl(lines, "default:");
      prepared.push(...extendAcl(defaults.length ? defaults : [
        { tag: "user", qualifier: "", permissions: 7 },
        { tag: "group", qualifier: "", permissions: 0 },
        { tag: "other", qualifier: "", permissions: 0 },
      ], [[access.hostUid, 7], [access.toolingUid, 7]], "default:"));
    }
    prepared.push("");
  }
  await command("setfacl", ["--restore=-"], new Blob([`${prepared.join("\n")}\n`]).stream());
  return access;
}

export const environmentCheckoutAccessCheck = `
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const workspace = fs.realpathSync(process.argv[1]), directories = new Set([workspace]);
let current = workspace;
for (;;) {
  let git;
  try { git = fs.statSync(path.join(current, ".git")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (git) {
    for (const argument of ["--git-dir", "--git-common-dir"]) {
      const result = spawnSync("git", ["-c", "safe.directory=" + current, "-C", current, "rev-parse",
        "--path-format=absolute", argument], { encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error("Cannot inspect the workspace Git directories: " + result.stderr);
      if (!result.stdout.endsWith("\\n") || result.stdout === "\\n") throw new Error("Git did not return a directory.");
      directories.add(result.stdout.slice(0, -1));
    }
    break;
  }
  const parent = path.dirname(current);
  if (parent === current) break;
  current = parent;
}
for (const directory of directories) {
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  const probe = fs.mkdtempSync(path.join(directory, ".clanky-access-"));
  try {
    fs.writeFileSync(path.join(probe, "write"), "", { flag: "wx", mode: 0o600 });
    fs.renameSync(path.join(probe, "write"), path.join(probe, "renamed"));
  } finally { fs.rmSync(probe, { recursive: true }); }
  const fetchHead = path.join(directory, "FETCH_HEAD");
  try { fs.accessSync(fetchHead, fs.constants.R_OK | fs.constants.W_OK); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
`;
