/**
 * Builds the copyable command used to enroll a Mesh worker.
 */

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildWorkerJoinCommand(input: {
  target: string;
  enrollmentToken: string;
  controllerFingerprint: string;
}): string {
  return [
    "clanky worker join",
    shellQuote(input.target),
    "--token",
    shellQuote(input.enrollmentToken),
    "--fingerprint",
    shellQuote(input.controllerFingerprint),
  ].join(" ");
}
