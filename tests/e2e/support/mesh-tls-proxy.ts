/**
 * External TLS-terminating proxy for compiled controller and relay listeners.
 * One HTTP request per connection keeps streaming bodies and WebSockets opaque.
 */
import { connect } from "node:net";
import { createServer } from "node:tls";

const [listenPort, upstreamPort, certificatePath, privateKeyPath] = process.argv.slice(2);
if (!listenPort || !upstreamPort || !certificatePath || !privateKeyPath) {
  throw new Error("Mesh TLS proxy requires ports, certificate and private key paths.");
}

const server = createServer({
  cert: await Bun.file(certificatePath).text(),
  key: await Bun.file(privateKeyPath).text(),
}, (client) => {
  let header = Buffer.alloc(0);
  const upstream = connect({ host: "127.0.0.1", port: Number(upstreamPort) });
  client.on("error", (error) => { console.error(String(error)); upstream.destroy(); });
  upstream.on("error", (error) => { console.error(String(error)); client.destroy(); });
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.setTimeout(60_000, () => client.destroy(new Error("Mesh TLS proxy connection timed out.")));
  const readHeader = (data: Buffer): void => {
    header = Buffer.concat([header, data]);
    const end = header.indexOf("\r\n\r\n");
    if (end === -1) {
      if (header.length > 64 * 1024) client.destroy(new Error("Mesh TLS proxy headers exceed the limit."));
      return;
    }
    client.pause();
    client.off("data", readHeader);
    const lines = header.subarray(0, end).toString("latin1").split("\r\n");
    const upgrade = lines.some((line) => /^upgrade:\s*websocket\s*$/i.test(line));
    const sanitized = lines.filter((line) =>
      !/^(forwarded|x-forwarded-[^:]+):/i.test(line)
      && (upgrade || !/^connection:/i.test(line)));
    sanitized.push("X-Forwarded-Proto: https");
    if (!upgrade) sanitized.push("Connection: close");
    upstream.write(`${sanitized.join("\r\n")}\r\n\r\n`, "latin1");
    upstream.write(header.subarray(end + 4));
    header = Buffer.alloc(0);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  };
  client.on("data", readHeader);
});
server.on("error", (error) => { console.error(String(error)); process.exitCode = 1; });
server.listen(Number(listenPort), "127.0.0.1");
