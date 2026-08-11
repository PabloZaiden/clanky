import { describe, expect, test } from "bun:test";
import { createClankyCli } from "../../src/cli";
import { CLANKY_VERSION } from "../../src/version";

describe("Clanky webapp CLI composition", () => {
  test("registers framework commands and Clanky domain commands together", () => {
    const cli = createClankyCli();

    expect(Object.keys(cli.commands)).toEqual(expect.arrayContaining([
      "help",
      "serve",
      "version",
      "config",
      "update",
      "logs",
      "api",
      "schema",
      "auth",
      "status",
      "profile",
      "ws",
      "mesh",
      "preview",
    ]));
  });

  test("uses the framework ws command without Clanky-specific filters", async () => {
    const result = await createClankyCli().execute(["ws", "--task-id", "task-1"]);

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("ws does not accept arguments");
  });

  test("keeps version and route catalog commands lazy", async () => {
    const cli = createClankyCli();

    expect(await cli.execute(["version"])).toEqual({
      exitCode: 0,
      output: CLANKY_VERSION,
    });

    const apiResult = await cli.execute(["api"]);
    expect(apiResult.exitCode).toBe(0);
    expect(apiResult.output).toContain("tasks");
  });
});
