/**
 * External native peers coordinate background work through real result files.
 */

export const BACKGROUND_DELEGATED = "Background work delegated; the report will arrive independently.";

export interface BackgroundWork {
  resultPath: string;
  releasePath: string;
}

export function backgroundWork(prompt: string): BackgroundWork | undefined {
  const resultPath = /\[background-result:([^\]\r\n]+)\]/.exec(prompt)?.[1];
  const releasePath = /\[continuation-release:([^\]\r\n]+)\]/.exec(prompt)?.[1];
  return resultPath && releasePath ? { resultPath, releasePath } : undefined;
}

export async function readBackgroundFile(path: string, signal: AbortSignal): Promise<string | undefined> {
  const deadline = Date.now() + 10_000;
  while (!signal.aborted) {
    if (await Bun.file(path).exists()) return await Bun.file(path).text();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Background work timed out waiting for ${path}.`);
    await new Promise<void>((resolve) => {
      const complete = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", complete);
        resolve();
      };
      const timer = setTimeout(complete, Math.min(25, remaining));
      signal.addEventListener("abort", complete, { once: true });
      if (signal.aborted) complete();
    });
  }
  return undefined;
}

export function backgroundFollowUp(prompt: string, report: string): string {
  return `Requested next step: ${prompt}\nBackground report available: ${report}`;
}
