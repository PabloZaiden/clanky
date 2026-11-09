import type { CliCommandResult, CliInput, WebAppCliCommandDefinition } from "@/platform/cli";
import { openLocalAccountStore, readLocalOwnerAuthStatus } from "@/persistence/accounts/local-store";
export { readLocalOwnerAuthStatus, type LocalOwnerAuthStatus } from "@/persistence/accounts/local-store";
import { initializeOwnerPassword } from "@/platform/server/auth/passwords";
import { assertValidUsername } from "@/platform/server/auth/users";

function setupUsername(args: readonly string[]): string {
  let username: string | undefined;
  let passwordStdin = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--username" && username === undefined && args[index + 1] && !args[index + 1]!.startsWith("--")) {
      username = args[++index];
    } else if (arg.startsWith("--username=") && username === undefined) {
      username = arg.slice("--username=".length);
    } else if (arg === "--password-stdin" && !passwordStdin) {
      passwordStdin = true;
    } else {
      throw new Error("Use auth setup --username <name> --password-stdin. Passwords cannot be supplied in arguments.");
    }
  }
  if (!username || !passwordStdin) throw new Error("Use auth setup --username <name> --password-stdin.");
  if (process.stdin.isTTY) throw new Error("--password-stdin requires a private pipe or redirected input.");
  return assertValidUsername(username);
}

async function readPassword(input: CliInput): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const encoded = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    bytes += encoded.byteLength;
    if (bytes > 1026) throw new Error("Passwords must contain at most 1024 bytes.");
    chunks.push(encoded);
  }
  const encoded = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(encoded).replace(/\r?\n$/, "");
  } catch {
    throw new Error("Password input must be valid UTF-8.");
  } finally {
    encoded.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function runAuthSetup(args: readonly string[], input: CliInput = Bun.stdin.stream() as unknown as CliInput): Promise<void> {
  const username = setupUsername(args);
  const accounts = openLocalAccountStore();
  try {
    if (accounts.store.countUsers() > 0) throw new Error("Accounts already exist; local setup cannot replace an owner or reset data.");
    let password = await readPassword(input);
    try {
      await initializeOwnerPassword(accounts.store, username, password);
    } finally {
      password = "";
    }
  } finally {
    accounts.close();
  }
}

const LOCAL_AUTH_USAGE = "auth status | auth setup --username <name> --password-stdin";
const LOCAL_AUTH_HELP = [
  `Usage: clanky ${LOCAL_AUTH_USAGE}`,
  "",
  "auth status",
  "  Print read-only local owner authentication status as JSON.",
  "",
  "auth setup --username <name> --password-stdin",
  "  Initialize the first local owner from a private UTF-8 stdin pipe.",
  "  Passwords require at least 12 characters and at most 1024 bytes.",
  "  Existing accounts are never replaced or reset.",
].join("\n");

export async function runLocalAuthCommand(
  args: readonly string[],
  input: CliInput = Bun.stdin.stream() as unknown as CliInput,
): Promise<CliCommandResult> {
  if (args.includes("--help") || args.includes("-h") || (args[0] === "help" && args.length === 1)) {
    return { exitCode: 0, output: LOCAL_AUTH_HELP };
  }
  try {
    if (args[0] === "status" && args.length === 1) {
      return { exitCode: 0, output: JSON.stringify(readLocalOwnerAuthStatus()) };
    }
    if (args[0] !== "setup") return { exitCode: 1, error: `Use ${LOCAL_AUTH_USAGE}.` };
    await runAuthSetup(args.slice(1), input);
    return { exitCode: 0, output: "Owner account initialized." };
  } catch (error) {
    return { exitCode: 1, error: error instanceof Error ? error.message : "Local authentication command failed." };
  }
}

export function createAuthCommand<TAppContext = undefined>(
  fallback?: WebAppCliCommandDefinition<TAppContext>,
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: "Inspect local owner authentication or initialize the first owner without starting the server.",
    usage: fallback?.usage ? `${LOCAL_AUTH_USAGE} | ${fallback.usage}` : LOCAL_AUTH_USAGE,
    async handler(context) {
      if (fallback && !["setup", "status", "help"].includes(context.args[0] ?? "")) {
        return await fallback.handler(context);
      }
      return await runLocalAuthCommand(context.args, context.stdin);
    },
  };
}
