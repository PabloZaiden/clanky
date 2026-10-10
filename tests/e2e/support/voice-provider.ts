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
import { liveFixtureWebSocket, type LiveFixture } from "./live-voice-provider";

export interface ManagedVoiceProvider {
  apiKey: string;
  baseUrl: string;
  certificatePath: string;
  server: Bun.Server<LiveFixture>;
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
  const apiKey = "voice-e2e-secret";
  const authorization = ["Bearer", apiKey].join(" ");
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

  let server: Bun.Server<LiveFixture> | undefined;
  const sessions = new Map<string, LiveFixture>();
  try {
    server = Bun.serve<LiveFixture>({
      hostname: address,
      port,
      tls: {
        key: Bun.file(keyPath),
        cert: Bun.file(certificatePath),
      },
      websocket: liveFixtureWebSocket,
      async fetch(request, server) {
        const url = new URL(request.url);
        if (
          request.headers.get("authorization") !== authorization
          || request.headers.get("api-key") !== apiKey
        ) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (url.pathname === "/v1/audio/transcriptions" && request.method === "POST") {
          return Response.json({ text: "transcribed by the external voice fixture" });
        }
        const path = url.pathname.replace(/^\/openai/, "");
        if (path === "/v1/live/sessions" && request.method === "POST") {
          const body = await request.json();
          if (body.session?.model !== "gpt-live-1" || body.session?.delegation?.type !== "responses"
            || body.transport?.type !== "webrtc" || !body.session.delegation.responses.tools?.length) {
            return Response.json({ error: "invalid_live_configuration" }, { status: 400 });
          }
          const id = crypto.randomUUID();
          const offer = String(body.transport.sdp);
          const mode = offer.includes("question") ? "question" : offer.includes("cut") ? "cut" : offer.includes("hold") ? "hold" : "steer";
          sessions.set(id, { id, stage: 0, streaming: false, active: false, mode });
          return Response.json({ session: { id }, transport: { type: "webrtc", sdp: "v=0\r\ns=external-live-provider\r\n" } }, { status: 201 });
        }
        const attach = /^\/v1\/live\/sessions\/([^/]+)\/attach$/.exec(path);
        if (attach) {
          const session = sessions.get(attach[1]!);
          if (!session) return new Response("Unknown session", { status: 404 });
          return server.upgrade(request, { data: session }) ? undefined : new Response("Expected websocket", { status: 400 });
        }
        if (path === "/v1/responses" && request.method === "POST") {
          const body = await request.json();
          const summary = JSON.stringify(body.input).includes("Transcript fragments");
          return Response.json({
            status: "completed",
            output: [{
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: summary ? "The caller requested workspace discovery and steering. The agent's work remains recorded separately in the chat." : "OK" }],
            }],
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    return {
      address,
      apiKey,
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
