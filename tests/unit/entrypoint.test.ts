import { describe, expect, test } from "bun:test";
import { parseMainCommand, runMain } from "../../src/entrypoint";

describe("entrypoint", () => {
  test("requires an explicit cli command", () => {
    expect(parseMainCommand([])).toEqual({ action: "help", exitCode: 1 });
    expect(parseMainCommand(["--help"])).toEqual({ action: "help", exitCode: 0 });
  });

  test("dispatches commands through the CLI runtime", async () => {
    let receivedCliArgs: string[] | null = null;

    const exitCode = await runMain(["status"], {
      runCliFn: async (args: string[]) => {
        receivedCliArgs = args;
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(receivedCliArgs).not.toBeNull();
    expect(receivedCliArgs!).toEqual(["status"]);
  });

  test("docker runs the standalone server binary", async () => {
    const dockerfile = await Bun.file(new URL("../../Dockerfile", import.meta.url)).text();
    expect(dockerfile).toContain("RUN cd apps/server && bun run build");
    expect(dockerfile).toContain('COPY --from=builder /app/apps/server/dist/clanky /app/clanky');
    expect(dockerfile).toContain('CMD ["/app/clanky"]');
  });
});
