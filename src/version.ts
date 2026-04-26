import packageJson from "../package.json";

export const RALPHER_VERSION = packageJson.version;

export function formatRalpherVersion(binaryName = "ralpher"): string {
  return `${binaryName} ${RALPHER_VERSION}`;
}
