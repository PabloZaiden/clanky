/**
 * Local HTTPS OpenAI-compatible boundary reachable through a public IP alias.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  currentEnvironment,
  findFreeLoopbackPort,
  requireCommand,
} from "./process";

export interface ManagedVoiceProvider {
  baseUrl: string;
  certificatePath: string;
  server: Bun.Server<undefined>;
  address: string;
}

function privileged(command: readonly string[]): string[] {
  return process.getuid?.() === 0
    ? [...command]
    : ["sudo", "-n", ...command];
}

function randomPublicAddress(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return `11.${String(bytes[0] || 1)}.${String(bytes[1] || 1)}.${String(bytes[2] || 1)}`;
}

export async function startVoiceProvider(
  runDirectory: string,
): Promise<ManagedVoiceProvider> {
  const directory = join(runDirectory, "voice-provider");
  const keyPath = join(directory, "tls.key");
  const certificatePath = join(directory, "tls.crt");
  const address = randomPublicAddress();
  const port = await findFreeLoopbackPort();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await requireCommand([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-days",
    "1",
    "-subj",
    `/CN=${address}`,
    "-addext",
    `subjectAltName=IP:${address}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
  ], {
    cwd: directory,
    env: currentEnvironment(),
  });
  await requireCommand(
    privileged(["ip", "address", "add", `${address}/32`, "dev", "lo"]),
    { cwd: directory },
  );

  let server: Bun.Server<undefined> | undefined;
  try {
    server = Bun.serve({
      hostname: address,
      port,
      tls: {
        key: Bun.file(keyPath),
        cert: Bun.file(certificatePath),
      },
      fetch(request) {
        const url = new URL(request.url);
        if (
          !request.headers.get("authorization")?.startsWith("Bearer ")
          || !request.headers.get("api-key")
        ) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (url.pathname === "/v1/audio/transcriptions" && request.method === "POST") {
          return Response.json({ text: "transcribed by the external voice fixture" });
        }
        if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
          return Response.json({
            choices: [{
              message: {
                role: "assistant",
                content: "OK",
              },
            }],
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    return {
      address,
      baseUrl: `https://${address}:${String(port)}/v1`,
      certificatePath,
      server,
    };
  } catch (error) {
    await requireCommand(
      privileged(["ip", "address", "del", `${address}/32`, "dev", "lo"]),
      { cwd: directory },
    );
    throw error;
  }
}

export async function stopVoiceProvider(
  provider: ManagedVoiceProvider,
): Promise<void> {
  await provider.server.stop(true);
  await requireCommand(
    privileged(["ip", "address", "del", `${provider.address}/32`, "dev", "lo"]),
    { cwd: "/" },
  );
}
