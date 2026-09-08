export const DEVBOX_REQUIRED_VERSION = "1.2.0";

export function parseDevboxVersion(output: string): string | null {
  const match = output.match(/^devbox v(\d+\.\d+\.\d+)\b/m);
  return match?.[1] ?? null;
}
