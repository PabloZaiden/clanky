/**
 * Materializes original files on their selected execution host, without parsing.
 */

import type { ExecutionHostBinding } from "@/shared/execution-host";
import { getRegisteredSshServerId } from "@/shared/execution-host";
import { SshCredentialsRequiredError } from "@/shared/chat";
import {
  getMessageAttachmentKind,
  isValidAttachmentBase64,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  type AttachmentContext,
  type AttachmentFileReference,
  type MessageAttachment,
  type PreparedAttachmentFiles,
} from "@/shared/message-attachments";
import { createLogger } from "@pablozaiden/webapp/server";
import { requireExecutionOwnerUserId } from "../context/user-context";
import { DomainError, isDomainError } from "../domain/domain-error";
import {
  assertAttachmentContextActive,
  forgetAttachmentLocation,
  listAttachmentLocations,
  rememberAttachmentLocation,
} from "../persistence/conversation-attachment-locations";
import { KeyedOperationQueue } from "../utils/keyed-operation-queue";
import { closeCommandExecutor, resolveCommandExecutorDirectory, type CommandExecutor } from "./command-executor";
import { dirnameExecutionPath, executionPathsEqual, type ExecutionPathStyle } from "./execution-path";
import { executionHostService } from "./execution-host-service";
import { GitService } from "./git";
import { ManagedPathService } from "./managed-path-service";
import { sshCredentialManager } from "./ssh-credential-manager";

const log = createLogger("conversation-attachments");

interface AttachmentMessage {
  id: string;
  attachments?: readonly MessageAttachment[];
}

interface MaterializeOptions {
  context: AttachmentContext;
  executionHost: ExecutionHostBinding;
  directory: string;
  message: AttachmentMessage;
  previousMessages?: Iterable<AttachmentMessage> | AsyncIterable<AttachmentMessage>;
  credentialToken?: string | null;
  signal?: AbortSignal;
}

interface MaterializationContext {
  executor: CommandExecutor;
  context: AttachmentContext;
  directory: string;
  signal?: AbortSignal;
}

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export class ConversationAttachmentService {
  private readonly operations = new KeyedOperationQueue();

  hasLocations(context: AttachmentContext): boolean {
    return listAttachmentLocations(context).length > 0;
  }

  credentialTargets(context: AttachmentContext): string[] {
    return [...new Set(listAttachmentLocations(context).flatMap((location) => {
      const serverId = getRegisteredSshServerId(location.executionHost.host);
      return serverId ? [serverId] : [];
    }))];
  }

  private token(context: AttachmentContext): string {
    return `${context.kind}-${hash(JSON.stringify([requireExecutionOwnerUserId(), context.id]))}`;
  }

  references(options: {
    context: AttachmentContext;
    directory: string;
    pathStyle: ExecutionPathStyle;
    message: AttachmentMessage;
  }): AttachmentFileReference[] {
    const paths = new ManagedPathService(options.pathStyle);
    return (options.message.attachments ?? []).flatMap((attachment, index) =>
      getMessageAttachmentKind(attachment) === "image" ? [] : [{
        attachmentIndex: index,
        path: paths.getConversationAttachmentPath({
          directory: options.directory,
          context: this.token(options.context),
          message: hash(options.message.id),
          attachment: `${index}-${hash(attachment.id)}`,
          filename: attachment.filename,
        }),
      }],
    );
  }

  private async getExecutor(options: {
    context: AttachmentContext;
    executionHost: ExecutionHostBinding;
    directory: string;
    credentialToken?: string | null;
  }): Promise<CommandExecutor> {
    const serverId = getRegisteredSshServerId(options.executionHost.host);
    const sshPassword = serverId && options.credentialToken
      ? sshCredentialManager.getPasswordForToken(serverId, options.credentialToken)
      : undefined;
    return await executionHostService.getCommandExecutor(options.executionHost, {
      directory: options.directory,
      operationId: `attachments:${options.context.kind}:${options.context.id}`,
      localUserId: requireExecutionOwnerUserId(),
      ...(sshPassword ? { sshPassword } : {}),
    });
  }

  async materialize(options: MaterializeOptions): Promise<PreparedAttachmentFiles> {
    return await this.operations.run(this.token(options.context), async () => {
      options.signal?.throwIfAborted();
      assertAttachmentContextActive(options.context);
      let context: MaterializationContext | undefined;
      const prepare = async (message: AttachmentMessage): Promise<AttachmentFileReference[]> => {
        if (!message.attachments?.some((attachment) => getMessageAttachmentKind(attachment) === "file")) return [];
        context ??= await this.open(options);
        return await this.materializeMessage(context, message);
      };
      try {
        for await (const message of options.previousMessages ?? []) {
          if (message.id !== options.message.id || !options.message.attachments?.length) await prepare(message);
        }
        const files = await prepare(options.message);
        options.signal?.throwIfAborted();
        assertAttachmentContextActive(options.context);
        return {
          files,
          ...(context ? {
            directory: new ManagedPathService(context.executor.pathStyle)
              .getConversationAttachmentDirectory(context.directory, this.token(options.context)),
          } : {}),
        };
      } catch (error) {
        options.signal?.throwIfAborted();
        if (isDomainError(error)) throw error;
        if (error instanceof SshCredentialsRequiredError) throw error;
        log.error("Execution-host file preparation failed", {
          context: options.context, cause: String(error),
        });
        throw new DomainError("attachment_write_failed", "Files could not be prepared on the execution host.", { cause: error });
      } finally {
        if (context) closeCommandExecutor(context.executor);
      }
    });
  }

  private async open(options: MaterializeOptions): Promise<MaterializationContext> {
    const executor = await this.getExecutor(options);
    try {
      const directory = await resolveCommandExecutorDirectory(executor, options.directory);
      const paths = new ManagedPathService(executor.pathStyle);
      const token = this.token(options.context);
      await this.assertManagedDirectories(executor, paths.getConversationAttachmentDirectory(directory, token), directory);
      rememberAttachmentLocation(options.context, {
        id: hash(JSON.stringify([options.executionHost, directory])),
        executionHost: options.executionHost,
        directory,
      });
      const git = GitService.withExecutor(executor);
      if (await git.isGitRepo(directory)) await git.ensureWorktreeExcluded(directory);
      return { executor, directory, context: options.context, signal: options.signal };
    } catch (error) {
      closeCommandExecutor(executor);
      throw error;
    }
  }

  private async materializeMessage(context: MaterializationContext, message: AttachmentMessage): Promise<AttachmentFileReference[]> {
    const files = this.references({
      context: context.context, directory: context.directory,
      pathStyle: context.executor.pathStyle, message,
    });
    for (const { attachmentIndex, path } of files) {
      context.signal?.throwIfAborted();
      const attachment = message.attachments![attachmentIndex]!;
      await this.assertManagedDirectories(context.executor, dirnameExecutionPath(path, context.executor.pathStyle), context.directory);
      const existing = await context.executor.getFileMetadata(path, { includeContentHash: false, signal: context.signal });
      if (existing && (existing.kind !== "file" || existing.isSymbolicLink)) {
        throw new DomainError("attachment_location_invalid", "An attachment destination is not an owned regular file.");
      }
      // Existing files may have been edited by the agent; the persisted original is separate.
      if (!existing) await this.writeFile(context, path, attachment);
    }
    return files;
  }

  private async writeFile(context: MaterializationContext, path: string, attachment: MessageAttachment): Promise<void> {
    if (!isValidAttachmentBase64(attachment.data) || attachment.size > MESSAGE_ATTACHMENT_MAX_BYTES) {
      throw new DomainError("attachment_data_invalid", "A saved attachment is invalid.");
    }
    const bytes = Buffer.from(attachment.data, "base64");
    if (bytes.byteLength !== attachment.size) throw new DomainError("attachment_data_invalid", "A saved attachment is incomplete.");
    const temporaryPath = `${path}.upload`;
    const existing = await context.executor.getFileMetadata(temporaryPath, { includeContentHash: false, signal: context.signal });
    if (existing && (existing.kind !== "file" || existing.isSymbolicLink)) {
      throw new DomainError("attachment_location_invalid", "The attachment staging path is not an owned regular file.");
    }
    let published = false;
    let failure: unknown;
    try {
      const result = await context.executor.writeFileStream?.(
        temporaryPath,
        new Blob([Uint8Array.from(bytes)]).stream(),
        { signal: context.signal, maxBytes: MESSAGE_ATTACHMENT_MAX_BYTES },
      );
      if (!result?.success || result.bytesWritten !== attachment.size) {
        throw new DomainError("attachment_write_failed", "The attachment could not be copied completely.", { cause: result?.error });
      }
      context.signal?.throwIfAborted();
      assertAttachmentContextActive(context.context);
      const moved = await context.executor.movePath(temporaryPath, path, { overwrite: false });
      if (!moved.success) throw new DomainError("attachment_write_failed", "The attachment could not be published.", { cause: moved.error });
      published = true;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (!published && await context.executor.getFileMetadata(temporaryPath, { includeContentHash: false })) {
        if (!await context.executor.deletePath(temporaryPath, { kind: "file" })) {
          throw new DomainError("attachment_cleanup_failed", "An incomplete attachment could not be removed.", {
            cause: failure,
          });
        }
      }
    }
  }

  private async assertManagedDirectories(executor: CommandExecutor, path: string, directory: string): Promise<void> {
    for (let current = path; !executionPathsEqual(current, directory, executor.pathStyle);) {
      const metadata = await executor.getFileMetadata(current, { includeContentHash: false });
      if (metadata && (metadata.kind !== "directory" || metadata.isSymbolicLink)) {
        throw new DomainError("attachment_location_invalid", "The managed attachment directory is not valid.");
      }
      const parent = dirnameExecutionPath(current, executor.pathStyle);
      if (executionPathsEqual(parent, current, executor.pathStyle)) {
        throw new DomainError("attachment_location_invalid", "The attachment path is outside its managed directory.");
      }
      current = parent;
    }
  }

  async cleanup(context: AttachmentContext, credentials: {
    credentialToken?: string | null;
    credentialTokensByServerId?: Record<string, string>;
  } = {}): Promise<void> {
    await this.operations.run(this.token(context), async () => {
      for (const location of listAttachmentLocations(context)) {
        const serverId = getRegisteredSshServerId(location.executionHost.host);
        const executor = await this.getExecutor({
          context, ...location,
          credentialToken: (serverId && credentials.credentialTokensByServerId?.[serverId]) || credentials.credentialToken,
        });
        try {
          const paths = new ManagedPathService(executor.pathStyle);
          const root = paths.getConversationAttachmentDirectory(location.directory, this.token(context));
          await this.assertManagedDirectories(executor, root, location.directory);
          const metadata = await executor.getFileMetadata(root, { includeContentHash: false });
          if (metadata && !await executor.deletePath(root, { kind: "directory", recursive: true })) {
            throw new DomainError("attachment_cleanup_failed", "The conversation attachments could not be removed.");
          }
          forgetAttachmentLocation(context, location.id);
        } finally {
          closeCommandExecutor(executor);
        }
      }
    });
  }
}

export const conversationAttachmentService = new ConversationAttachmentService();
