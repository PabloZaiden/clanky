import { describe, expect, test } from "bun:test";
import { parseCliCommand } from "../../src/cli/runtime";

describe("clanky preview command parsing", () => {
  test("requires workspace and port", () => {
    expect(() => parseCliCommand(["preview", "--workspace", "app"])).toThrow("Missing required option: --port");
    expect(() => parseCliCommand(["preview", "--port", "3000"])).toThrow("Missing required option: --workspace");
  });

  test("parses defaults and normalizes path", () => {
    expect(parseCliCommand(["preview", "--workspace", "app", "--port", "3000", "--path", "dashboard"])).toEqual({
      action: "preview",
      baseUrl: undefined,
      workspace: "app",
      port: 3000,
      remoteHost: "127.0.0.1",
      host: "127.0.0.1",
      localPort: undefined,
      path: "/dashboard",
      open: false,
    });
  });

  test("rejects invalid ports and accepts LAN exposure flag", () => {
    expect(() => parseCliCommand(["preview", "--workspace", "app", "--port", "70000"])).toThrow("--port must be an integer between 1 and 65535");
    expect(parseCliCommand([
      "preview",
      "--workspace",
      "app",
      "--port",
      "3000",
      "--host",
      "0.0.0.0",
      "--local-port",
      "43123",
      "--open",
    ])).toMatchObject({
      action: "preview",
      host: "0.0.0.0",
      localPort: 43123,
      open: true,
    });
  });
});
