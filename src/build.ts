import twPlugin from 'bun-plugin-tailwind'
import { log } from './core/logger';

// workDir is the current file's directory + '/..'
const workDir = import.meta.dir + '/..';

// create a temp directory for output in the os temp directory
const outDir = await Bun.$`mktemp -d`.text().then(s => s.trim());
const finalOutDir = `${workDir}/dist`;
const originalCwd = process.cwd();

// Parse --target argument (e.g., --target=linux-x64)
const targetArg = process.argv.find(arg => arg.startsWith('--target='));
const target = targetArg?.split('=')[1] as
  | 'bun-linux-x64'
  | 'bun-linux-arm64'
  | 'bun-darwin-x64'
  | 'bun-darwin-arm64'
  | 'bun-windows-x64'
  | undefined;

const outfile = target?.startsWith('bun-windows') ? `${outDir}/clanky.exe` : `${outDir}/clanky`;
let buildSucceeded = false;

try {
  log.info('Building server binary...');
  if (target) {
    log.info(`Target: ${target}`);
  }

  // Bun's compile step currently resolves the rename target relative to the
  // current working directory on this filesystem, so build from the temp output
  // directory to keep the final rename in the correct location.
  process.chdir(outDir);
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [ `${workDir}/src/index.ts`],
      compile: target 
        ? { outfile, target } 
        : { outfile },
      plugins: [twPlugin],
      minify: true,
      sourcemap: true,
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
      },
    });
  } finally {
    process.chdir(originalCwd);
  }

  if (!result.success) {
    log.error('Build failed:');
    for (const _log of result.logs) {
      log.error(_log);
    }
    process.exitCode = 1;
  } else {
    log.info('Ensuring dist directory exists...');
    await Bun.$`mkdir -p ${finalOutDir}`.quiet();

    log.info('Copying built file to dist directory...');
    const destName = target ? `clanky-${target.replace('bun-', '')}` : 'clanky';
    const destPath = `${finalOutDir}/${destName}`;
    await Bun.write(destPath, Bun.file(outfile));

    // Mark the output binary as executable (skip for Windows targets)
    if (!target?.startsWith('bun-windows')) {
      await Bun.$`chmod +x ${destPath}`.quiet();
    }

    buildSucceeded = true;
    log.info('Build completed:', outfile);
  }
} finally {
  process.chdir(originalCwd);
  log.info('Cleaning up temporary files...');
  await Bun.$`rm -rf ${outDir}`.quiet();
}

if (!buildSucceeded) {
  process.exit(process.exitCode ?? 1);
}
