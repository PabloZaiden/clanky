import type { ExecutionHostRef } from "../../shared/execution-host";

export function environmentCommand(
  host: ExecutionHostRef,
  owner: string,
  args: readonly string[],
): { command: string; args: string[] } {
  const separator = args.indexOf("--");
  const owned = separator < 0
    ? [...args, "--owner", owner]
    : [...args.slice(0, separator), "--owner", owner, ...args.slice(separator)];
  const local = host.kind === "local";
  const entrypoint = local && !Bun.main.includes("/$bunfs/") && Bun.main !== process.execPath
    ? [Bun.main] : [];
  return {
    command: local ? process.execPath : "clanky",
    args: [...entrypoint, "environment", ...owned],
  };
}
