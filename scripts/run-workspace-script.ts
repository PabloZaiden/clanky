const rootDir = `${import.meta.dir}/..`;
const workspaceDirs = [
  "packages/shared",
  "packages/contracts",
  "packages/client-sdk",
  "apps/api",
  "apps/web",
  "apps/cli",
  "apps/tui",
  "apps/electron",
];

interface WorkspacePackageJson {
  name?: string;
  scripts?: Record<string, string>;
}

async function runWorkspaceScript(scriptName: string): Promise<void> {
  for (const workspaceDir of workspaceDirs) {
    const packageJsonPath = `${rootDir}/${workspaceDir}/package.json`;
    const packageJson = JSON.parse(
      await Bun.file(packageJsonPath).text(),
    ) as WorkspacePackageJson;
    if (!packageJson.scripts?.[scriptName]) {
      continue;
    }

    const label = packageJson.name ?? workspaceDir;
    console.log(`== ${label} :: ${scriptName} ==`);
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", scriptName],
      cwd: `${rootDir}/${workspaceDir}`,
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    console.log("");
  }
}

const scriptName = process.argv[2];
if (!scriptName) {
  throw new Error("Usage: bun scripts/run-workspace-script.ts <script-name>");
}

await runWorkspaceScript(scriptName);
