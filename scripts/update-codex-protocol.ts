/**
 * Regenerates only the native adapter's reachable official Codex bindings.
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";

const executable = Bun.which("codex");
if (!executable) throw new Error("Codex CLI is required to regenerate its native protocol.");
const output = await mkdtemp(join(tmpdir(), "clanky-codex-bindings-"));
const destination = resolve(import.meta.dir, "../src/backends/codex/generated");
const roots = [
  "InitializeParams", "InitializeResponse",
  ...[
    "ModelList", "ConfigRead", "ThreadStart", "ThreadResume", "ThreadRead", "ThreadList",
    "ThreadDelete", "ThreadItemsList", "ThreadTurnsList", "TurnStart", "TurnSteer",
    "TurnInterrupt", "ThreadBackgroundTerminalsList", "ThreadBackgroundTerminalsTerminate",
  ].flatMap((name) => [`v2/${name}Params`, `v2/${name}Response`]),
  ...[
    "ThreadStarted", "ThreadStatusChanged", "TurnStarted", "TurnCompleted",
    "ItemStarted", "ItemCompleted", "AgentMessageDelta", "ReasoningTextDelta",
    "ReasoningSummaryTextDelta", "CommandExecutionOutputDelta", "Error",
    "ServerRequestResolved",
  ].map((name) => `v2/${name}Notification`),
  "v2/ToolRequestUserInputParams", "v2/ToolRequestUserInputResponse",
  "v2/ConfigRequirementsReadResponse",
];
try {
  const generated = Bun.spawn([executable, "app-server", "generate-ts", "--experimental", "--out", output], { stdout: "inherit", stderr: "inherit" });
  if (await generated.exited !== 0) throw new Error("Codex protocol generation failed.");
  const seen = new Set<string>();
  const copy = async (path: string): Promise<void> => {
    const file = resolve(output, `${path}.ts`);
    if (seen.has(file)) return;
    if (!file.startsWith(`${output}/`)) throw new Error("Generated import escapes the protocol output.");
    seen.add(file);
    const content = await Bun.file(file).text();
    for (const match of content.matchAll(/from "(\.[^"]+)"/g)) {
      const imported = resolve(dirname(file), match[1]!.replace(/\.js$/, ""));
      await copy(relative(output, imported));
    }
    const target = join(destination, relative(output, file));
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, content);
  };
  for (const root of roots) await copy(root);
  await Bun.write(join(destination, "index.ts"), [
    "// Generated from codex app-server by scripts/update-codex-protocol.ts.",
    ...roots.map((root) => `export type { ${root.split("/").at(-1)} } from "./${root}";`),
    "",
  ].join("\n"));
  console.log(`Generated ${seen.size} reachable protocol types.`);
} finally {
  await rm(output, { recursive: true, force: true });
}
