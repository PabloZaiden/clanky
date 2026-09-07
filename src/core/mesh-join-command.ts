/**
 * Builds the copyable command used to enroll a Mesh worker.
 */

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildWorkerJoinCommand(input: {
  controllerEndpoint: string;
  enrollmentToken: string;
  controllerFingerprint: string;
}): string {
  return [
    "clanky worker join",
    "--controller",
    shellQuote(input.controllerEndpoint),
    "--token",
    shellQuote(input.enrollmentToken),
    "--fingerprint",
    shellQuote(input.controllerFingerprint),
  ].join(" ");
}
