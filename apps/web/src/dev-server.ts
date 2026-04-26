import index from "./index.html";

const port = Number.parseInt(process.env["RALPHER_WEB_PORT"] ?? "3001", 10);
const host = process.env["RALPHER_WEB_HOST"]?.trim() || "127.0.0.1";

const server = Bun.serve({
  hostname: host,
  port,
  routes: {
    "/*": index,
  },
  development: true,
});

console.log(`Ralpher web app running at ${server.url}`);
