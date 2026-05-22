import packageJson from "../package.json";

export const CLANKY_VERSION = packageJson.version;

export function formatClankyVersion(binaryName = "clanky"): string {
  return `${binaryName} ${CLANKY_VERSION}`;
}
