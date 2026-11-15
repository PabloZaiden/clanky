import net from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createLogger } from "@pablozaiden/webapp/server";
import { SSH_AGENT_MAX_FRAME_BYTES } from "@/shared/ssh-key-access";
import { SSH_AGENT_FAILURE, sshAgentError, sshFrame } from "./ssh-agent-protocol";

const log = createLogger("ssh-agent");
async function removeStaleSocket(socketPath: string): Promise<void> {
  let existing;
  try { existing = await lstat(socketPath); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw sshAgentError("socket_in_use", "The scoped SSH-agent path is not an owned Unix socket.");
  const stale = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(socketPath);
    const finish = (result: boolean): void => { probe.destroy(); resolve(result); };
    probe.setTimeout(500, () => finish(false));
    probe.once("connect", () => finish(false));
    probe.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" || error.code === "ENOENT"));
  });
  if (!stale) throw sshAgentError("socket_in_use", "The scoped SSH-agent socket is already active.");
  const current = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current && (current.ino !== existing.ino || !current.isSocket())) throw sshAgentError("socket_in_use", "The scoped SSH-agent path changed during startup.");
  if (current) await unlink(socketPath);
}
export interface ScopedSshAgentSocket {
  socketPath: string;
  close(): Promise<void>;
}
export async function openScopedSshAgentSocket(
  socketPath: string,
  request: (payload: Buffer) => Promise<Buffer>,
): Promise<ScopedSshAgentSocket> {
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 103) throw sshAgentError("socket_invalid", "The scoped SSH-agent socket path must be absolute and at most 103 bytes.");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) {
    throw sshAgentError("socket_invalid", "The scoped SSH-agent directory must be private and owned by the worker user.");
  }
  await removeStaleSocket(socketPath);
  const clients = new Set<net.Socket>();
  const server = net.createServer((client) => {
    if (clients.size >= 32) { client.destroy(); return; }
    clients.add(client);
    client.once("close", () => clients.delete(client));
    client.on("error", () => {});
    client.setTimeout(30_000, () => client.destroy());
    let pending: Buffer = Buffer.alloc(0);
    let busy = false;
    const consume = async (): Promise<void> => {
      if (busy || client.destroyed) return;
      if (pending.length < 4) return;
      const length = pending.readUInt32BE(0);
      if (!length || length > SSH_AGENT_MAX_FRAME_BYTES) { client.destroy(); return; }
      if (pending.length < length + 4) return;
      busy = true;
      client.pause();
      const payload = pending.subarray(4, length + 4);
      pending = pending.subarray(length + 4);
      let response: Buffer;
      try { response = await request(payload); }
      catch (error) {
        log.warn("Scoped SSH-agent operation refused", { code: error && typeof error === "object" && "code" in error ? String(error.code) : "ssh_agent_unavailable" });
        response = SSH_AGENT_FAILURE;
      }
      if (!client.destroyed) {
        await new Promise<void>((resolve) => client.write(sshFrame(response), () => resolve()));
        busy = false;
        client.resume();
        await consume();
      }
    };
    client.on("data", (chunk: Buffer) => {
      if (pending.length + chunk.length > SSH_AGENT_MAX_FRAME_BYTES + 4) { client.destroy(); return; }
      pending = Buffer.concat([pending, chunk]);
      void consume().catch(() => client.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
  });
  try { await chmod(socketPath, 0o600); }
  catch (error) { server.close(); await unlink(socketPath).catch(() => {}); throw error; }
  const owned = await lstat(socketPath);
  let closed = false;
  return {
    socketPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const current = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current?.ino === owned.ino) await unlink(socketPath);
    },
  };
}
