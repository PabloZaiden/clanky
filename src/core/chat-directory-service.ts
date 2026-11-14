import type { Chat, ChatRepositoryContext } from "@/shared/chat";
import { requireExecutionOwnerUserId } from "../context/user-context";
import { DomainError, isDomainError } from "../domain/domain-error";
import {
  closeCommandExecutor,
  resolveCommandExecutorDirectory,
  type CommandExecutor,
} from "./command-executor";
import { executionHostService } from "./execution-host-service";
import { getChatExecutionHostBinding } from "./chat-history-export-service";
import type { ChatStatePort } from "./chat-service-contracts";
import { executionPathsEqual } from "./execution-path";
import { GitService } from "./git";
import { getWorkingTreeDiff, getWorkingTreeFileDiff } from "./git/git-diff";
import { ManagedPathService } from "./managed-path-service";

interface ChatDirectoryContext {
  chat: Chat;
  executor: CommandExecutor;
  directory: string;
}

const log = createLogger("core:chat-directory");

export class ChatDirectoryService {
  constructor(private readonly state: Pick<ChatStatePort, "getChatSummary" | "getWorkspace">) {}

  async getDiff(chatId: string) {
    return this.withDirectory(chatId, async ({ chat, executor, directory }) => {
      if (!await this.isGitRepository(executor, directory)) {
        throw new DomainError("chat_git_unavailable", "This chat's directory is not a Git repository.");
      }
      const git = GitService.withExecutor(executor);
      const branch = await this.getBranch(executor, directory);
      const configuredBase = chat.state.worktree?.originalBranch ?? chat.config.baseBranch;
      const base = configuredBase && configuredBase !== branch
        ? configuredBase
        : await git.getDefaultBranch(directory);
      return await getWorkingTreeDiff(executor, directory, base);
    });
  }

  async getPlanningFile(chatId: string, file: "plan" | "status") {
    return this.withDirectory(chatId, async ({ executor, directory }) => {
      const paths = new ManagedPathService(executor.pathStyle);
      const path = file === "plan"
        ? paths.getPlanFilePath(directory)
        : paths.getStatusFilePath(directory);
      const metadata = await executor.getFileMetadata(path, { includeContentHash: false });
      if (!metadata) return { exists: false, content: "" };
      if (metadata.kind !== "file") {
        throw new DomainError("chat_document_read_failed", `The ${file} document is not a file.`);
      }
      const content = await executor.readFile(path);
      if (content === null) {
        throw new DomainError("chat_document_read_failed", `The ${file} document could not be read.`);
      }
      return { exists: true, content };
    });
  }

  async getFileDiff(chatId: string, base: string, path: string) {
    return this.withDirectory(chatId, async ({ executor, directory }) => {
      const file = await getWorkingTreeFileDiff(executor, directory, base, path);
      if (!file) {
        throw new DomainError("chat_diff_file_not_found", "The file is no longer in this change list.");
      }
      return file;
    });
  }

  async getRepositoryContext(chatId: string): Promise<ChatRepositoryContext> {
    return this.withDirectory(chatId, async ({ executor, directory }) => {
      if (!await this.isGitRepository(executor, directory)) {
        return { isGitRepo: false, branch: null, pullRequest: null, pullRequestLookup: "none" };
      }
      const branch = await this.getBranch(executor, directory);
      const context: ChatRepositoryContext = {
        isGitRepo: true,
        branch,
        pullRequest: null,
        pullRequestLookup: "unavailable",
      };
      if (!branch) return { ...context, message: "Pull request lookup is unavailable for a detached HEAD." };
      try {
        const readPullRequests = async (state: "open" | "all"): Promise<unknown[]> => {
          const result = await executor.exec("gh", [
            "pr", "list", "--head", branch, "--state", state, "--limit", "1", "--json", "number,url,state",
          ], { cwd: directory, timeout: 5_000, logFailures: false });
          if (!result.success) throw new Error(`Pull request lookup exited with code ${result.exitCode}`);
          const entries: unknown = JSON.parse(result.stdout);
          if (!Array.isArray(entries)) throw new Error("Invalid pull request response");
          return entries;
        };
        let entries = await readPullRequests("open");
        if (entries.length === 0) entries = await readPullRequests("all");
        if (entries.length === 0) return { ...context, pullRequestLookup: "none" };
        const entry = entries[0] as Record<string, unknown> | null;
        if (!entry || !Number.isSafeInteger(entry["number"]) || Number(entry["number"]) <= 0
          || typeof entry["url"] !== "string"
          || !["OPEN", "CLOSED", "MERGED"].includes(String(entry["state"]))) {
          throw new Error("Invalid pull request response");
        }
        const state = entry["state"] === "OPEN" ? "open"
          : entry["state"] === "CLOSED" ? "closed" : "merged";
        const url = new URL(entry["url"]);
        if (!["https:", "http:"].includes(url.protocol)
          || !url.pathname.endsWith(`/pull/${String(entry["number"])}`)) {
          throw new Error("Invalid pull request URL");
        }
        return {
          ...context,
          pullRequest: { number: Number(entry["number"]), url: url.toString(), state },
          pullRequestLookup: "found",
        };
      } catch (error) {
        log.warn("Existing pull request lookup failed", {
          chatId,
          errorType: error instanceof Error ? error.name : "unknown",
        });
        return { ...context, message: "Existing pull requests could not be checked on the execution host." };
      }
    });
  }

  async preparePlanningKickoff(chatId: string): Promise<void> {
    await this.withDirectory(chatId, async ({ executor, directory }) => {
      try {
        const available = await executor.execGit(directory, ["version"], {
          scope: "repository", logFailures: false,
        });
        if (!available.success) return;
      } catch (error) {
        if (isDomainError(error) && error.code === "execution_host_capability_unavailable"
          && error.details["capability"] === "git") return;
        throw error;
      }
      if (await this.isGitRepository(executor, directory)) {
        await GitService.withExecutor(executor).ensureWorktreeExcluded(directory);
      }
    });
  }

  private async isGitRepository(executor: CommandExecutor, directory: string): Promise<boolean> {
    const result = await executor.execGit(directory, ["rev-parse", "--is-inside-work-tree"], {
      scope: "repository", logFailures: false,
    });
    if (result.success) return result.stdout.trim() === "true";
    if (/not a git repository/i.test(result.stderr)) return false;
    throw new DomainError("chat_repository_read_failed", "Git repository information could not be read.");
  }

  private async getBranch(executor: CommandExecutor, directory: string): Promise<string | null> {
    const result = await executor.execGit(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      scope: "repository", logFailures: false,
    });
    if (result.success && result.stdout.trim()) return result.stdout.trim();
    if (result.exitCode === 1) return null;
    throw new DomainError("chat_repository_read_failed", "The current Git branch could not be read.");
  }

  private async withDirectory<T>(
    chatId: string,
    read: (context: ChatDirectoryContext) => Promise<T>,
  ): Promise<T> {
    const chat = await this.state.getChatSummary(chatId);
    if (!chat) throw new DomainError("chat_not_found", "Chat not found.");
    const binding = await getChatExecutionHostBinding(this.state, chat);
    const executor = await executionHostService.getCommandExecutor(binding, {
      directory: chat.config.directory,
      operationId: `chat-directory:${chatId}`,
      localUserId: requireExecutionOwnerUserId(),
    });
    try {
      let directory = chat.state.session?.binding?.directory
        ?? chat.state.worktree?.worktreePath
        ?? chat.config.directory;
      if (chat.config.useWorktree) {
        const worktreePath = chat.state.worktree?.worktreePath;
        if (!worktreePath) {
          throw new DomainError("chat_directory_unavailable", "The chat worktree has not been prepared.");
        }
        const canonical = await GitService.withExecutor(executor).assertCanonicalManagedWorktreePath(
          chat.config.directory, chat.config.id, worktreePath,
        );
        if (!executionPathsEqual(directory, canonical, executor.pathStyle)) {
          throw new DomainError("chat_directory_unavailable", "The chat's execution directory no longer matches its worktree.");
        }
        directory = canonical;
      }
      directory = await resolveCommandExecutorDirectory(executor, directory);
      if (!await executor.directoryExists(directory)) {
        throw new DomainError("chat_directory_unavailable", "The chat's execution directory is unavailable.");
      }
      return await read({ chat, executor, directory });
    } finally {
      closeCommandExecutor(executor);
    }
  }
}
import { createLogger } from "@pablozaiden/webapp/server";
