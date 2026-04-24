interface BuildStep {
  label: string;
  cmd: string[];
}

interface BuildStepResult {
  step: BuildStep;
  exitCode: number;
  output: string;
  elapsedMs: number;
}

const rootDir = `${import.meta.dir}/..`;

const buildSteps: BuildStep[] = [
  {
    label: "typecheck",
    cmd: [process.execPath, "run", "tsc"],
  },
  {
    label: "compile",
    cmd: [process.execPath, "src/build.ts"],
  },
];

function formatDuration(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) {
    return "";
  }
  return await new Response(stream).text();
}

function summarizeOutput(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return "(no output)";
  }

  return lines.slice(-4).join("\n");
}

async function runStep(step: BuildStep): Promise<BuildStepResult> {
  const start = Date.now();
  const proc = Bun.spawn({
    cmd: step.cmd,
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ]);

  return {
    step,
    exitCode,
    output: [stdout, stderr].filter((value) => value.length > 0).join("\n"),
    elapsedMs: Date.now() - start,
  };
}

console.log("Running build steps in parallel...");
for (const step of buildSteps) {
  console.log(`- ${step.label}`);
}
console.log("");

const startedAt = Date.now();
const results = await Promise.all(buildSteps.map((step) => runStep(step)));
let failed = false;

for (const result of results) {
  const status = result.exitCode === 0 ? "PASS" : "FAIL";
  if (result.exitCode !== 0) {
    failed = true;
  }

  console.log(`== ${result.step.label} ${status} (${formatDuration(result.elapsedMs)}) ==`);
  console.log(result.exitCode === 0 ? summarizeOutput(result.output) : result.output.trim());
  console.log("");
}

console.log(`Build completed in ${formatDuration(Date.now() - startedAt)}.`);

if (failed) {
  process.exit(1);
}
