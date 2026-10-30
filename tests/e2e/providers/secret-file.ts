import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const SECRET_TOOL = "clanky_request_secret";
const PREFIX = "Secret request: ";

export function secretRequest(prompt: string): Record<string, unknown> | undefined {
  const line = prompt.split("\n").find((value) => value.includes(PREFIX));
  return line ? JSON.parse(line.slice(line.indexOf(PREFIX) + PREFIX.length)) : undefined;
}

export async function secretUnavailable(prompt: string, directory: string): Promise<string> {
  if (!prompt.includes("<promise>PLAN_READY</promise>")) return "Secret tool unavailable.";
  await mkdir(join(directory, ".clanky-planning"), { recursive: true });
  await Bun.write(join(directory, ".clanky-planning", "plan.md"), "# CLI integration\nUse only provisioned credentials in autonomous execution.");
  await Bun.write(join(directory, ".clanky-planning", "status.md"), "No secret requested; awaiting plan review.");
  return "Secret tool unavailable.\n<promise>PLAN_READY</promise>";
}

export async function consumeSecretFile(result: unknown): Promise<string> {
  if (typeof result !== "object" || result === null || !("status" in result)) {
    throw new Error("The native secret tool returned an invalid result.");
  }
  if (result.status === "declined") return "Secret declined.";
  if (result.status !== "saved" || !("path" in result) || typeof result.path !== "string"
    || !("expiresAt" in result) || typeof result.expiresAt !== "number") {
    throw new Error("The native secret tool did not return a file reference.");
  }
  const cli = Bun.spawn([process.execPath, "-e", `
    const bytes = await Bun.stdin.bytes();
    process.stdout.write(JSON.stringify({
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    }));
  `], { stdin: Bun.file(result.path), stdout: "pipe", stderr: "pipe" });
  const [output, diagnostic, exitCode] = await Promise.all([
    new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited,
  ]);
  if (exitCode !== 0) throw new Error(`The external secret-consuming CLI failed: ${diagnostic}`);
  return `Secret file used: ${JSON.stringify({ path: result.path, expiresAt: result.expiresAt, ...JSON.parse(output) })}`;
}
