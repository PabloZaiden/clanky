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
    label: "novnc-vendor",
    cmd: [process.execPath, "run", "build:novnc"],
  },
  {
    label: "typecheck",
    cmd: [process.execPath, "run", "tsc"],
  },
  {
    label: "workspace-build",
    cmd: [process.execPath, "run", "build:workspaces"],
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
const setupStep = buildSteps[0];
if (!setupStep) {
  throw new Error("No build steps configured.");
}
const parallelSteps = buildSteps.slice(1);
console.log(`- ${setupStep.label}`);
for (const step of parallelSteps) {
  console.log(`- ${step.label}`);
}
console.log("");

const startedAt = Date.now();
const setupResult = await runStep(setupStep);
const results = setupResult.exitCode === 0
  ? [setupResult, ...(await Promise.all(parallelSteps.map((step) => runStep(step))))]
  : [setupResult];
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
