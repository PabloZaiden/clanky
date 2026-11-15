/**
 * Main binary entrypoint for the Clanky CLI.
 */

import "reflect-metadata";

try {
  const args = Bun.argv.slice(2);
  if (args[0] === "auth" && ["setup", "status", "help"].includes(args[1] ?? "")) {
    const { runLocalAuthCommand } = await import("./cli/auth-setup");
    const result = await runLocalAuthCommand(args.slice(1));
    if (result.output !== undefined) process.stdout.write(`${result.output}\n`);
    if (result.error !== undefined) process.stderr.write(`${result.error}\n`);
    process.exitCode = result.exitCode;
  } else if (args[0] === "environment") {
    const { runEnvironmentCommand } = await import("./cli/environment");
    process.exitCode = await runEnvironmentCommand(args.slice(1));
  } else {
    const { createClankyCli } = await import("./cli");
    process.exitCode = await createClankyCli().run(args);
  }
} catch (error) {
  console.error(`Fatal error: ${String(error)}`);
  process.exitCode = 1;
}
