import packageJson from "../package.json";

export const RALPHER_VERSION = packageJson.version;

export function formatRalpherVersion(): string {
  return `ralpher ${RALPHER_VERSION}`;
}
