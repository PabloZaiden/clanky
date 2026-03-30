import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function createHttpError(status, body) {
  const error = new Error(`HTTP ${String(status)}: ${body}`);
  error.status = status;
  error.body = body;
  return error;
}

async function findAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve a test port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHealth(baseUrl, getLogs) {
  const startTime = Date.now();
  while (Date.now() - startTime < 20000) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling while the server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Playwright test server.\n${getLogs()}`);
}

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync("git", args, cwd ? { cwd } : undefined);
  return String(stdout).trim();
}

async function requestJson(baseUrl, path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    throw createHttpError(response.status, await response.text());
  }
  return await response.json();
}

async function terminateChildProcess(child, childExited, timeoutMs = 5000) {
  if (child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
  }
  const killTimeout = setTimeout(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }, timeoutMs);
  try {
    await childExited;
  } finally {
    clearTimeout(killTimeout);
  }
}

export async function startTestApp(repoRoot) {
  const tempRoot = await mkdtemp(join(tmpdir(), "ralpher-playwright-"));
  const dataDir = join(tempRoot, "data");
  const reposDir = join(tempRoot, "repos");
  await mkdir(dataDir, { recursive: true });
  await mkdir(reposDir, { recursive: true });

  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  let combinedLogs = "";

  const child = spawn("bun", ["tests/playwright/support/server.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      RALPHER_DATA_DIR: dataDir,
      RALPHER_HOST: "127.0.0.1",
      RALPHER_PORT: String(port),
      RALPHER_LOG_LEVEL: "fatal",
      RALPHER_MOCK_ACP: "true",
    },
    stdio: "pipe",
  });

  child.stdout.on("data", (chunk) => {
    combinedLogs += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    combinedLogs += chunk.toString("utf8");
  });

  const childExited = new Promise((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });

  child.once("error", (error) => {
    combinedLogs += `${String(error)}\n`;
  });

  try {
    await waitForHealth(baseUrl, () => combinedLogs);
  } catch (error) {
    await terminateChildProcess(child, childExited);
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  async function createGitRepository(name) {
    const repoDirectory = join(reposDir, name);
    const remoteDirectory = `${repoDirectory}-remote.git`;
    await mkdir(repoDirectory, { recursive: true });
    await writeFile(join(repoDirectory, "README.md"), `# ${name}\n`);
    await runGit(["init", repoDirectory]);
    await runGit(["-C", repoDirectory, "config", "user.email", "test@test.com"]);
    await runGit(["-C", repoDirectory, "config", "user.name", "Playwright Test"]);
    await runGit(["-C", repoDirectory, "add", "."]);
    await runGit(["-C", repoDirectory, "commit", "-m", "Initial commit"]);
    const defaultBranch = await runGit(["-C", repoDirectory, "branch", "--show-current"]);
    await runGit(["init", "--bare", remoteDirectory]);
    await runGit(["-C", repoDirectory, "remote", "add", "origin", remoteDirectory]);
    await runGit(["-C", repoDirectory, "push", "-u", "origin", defaultBranch]);
    await runGit(["-C", remoteDirectory, "symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`]);
    return {
      directory: repoDirectory,
      remoteDirectory,
      defaultBranch,
    };
  }

  async function createWorkspace(options) {
    const transport = options.transport ?? "stdio";
    const serverSettings = transport === "ssh"
      ? {
          agent: {
            provider: "copilot",
            transport: "ssh",
            hostname: "127.0.0.1",
            username: "tester",
            port: 22,
          },
        }
      : {
          agent: {
            provider: "copilot",
            transport: "stdio",
          },
        };

    return await requestJson(baseUrl, "/api/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: options.name,
        directory: options.directory,
        serverSettings,
      }),
    });
  }

  async function stop() {
    await terminateChildProcess(child, childExited);
    await rm(tempRoot, { recursive: true, force: true });
  }

  return {
    baseUrl,
    createGitRepository,
    createWorkspace,
    listLoops: async () => await requestJson(baseUrl, "/api/loops"),
    getLoop: async (loopId) => await requestJson(baseUrl, `/api/loops/${loopId}`),
    listChats: async () => await requestJson(baseUrl, "/api/chats"),
    getChat: async (chatId) => await requestJson(baseUrl, `/api/chats/${chatId}`),
    listSshSessions: async () => await requestJson(baseUrl, "/api/ssh-sessions"),
    getSshSession: async (sessionId) => await requestJson(baseUrl, `/api/ssh-sessions/${sessionId}`),
    stop,
  };
}
