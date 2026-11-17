import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import parseCss from "css-tree/parser";
import walkCss from "css-tree/walker";
import generateCss from "css-tree/generator";
import type { StringNode, Url } from "css-tree";
import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DomainError } from "@/domain/domain-error";
import { HtmlPreviewInputSchema, HtmlRenderInputSchema, type HtmlSource } from "@/contracts/schemas/html-render";
import { bootstrapHtml, HTML_IMAGE_MAX_BYTES, HTML_MAX_BYTES } from "@/shared/html-render";
import { executionHostBindingsEqual } from "@/shared/execution-host";
import { detectBrowserImageMimeType } from "@/utils/workspace-file-images";
import { loadChatMetadata, getChatMessageFromTranscript } from "../persistence/chats";
import { listHtmlAttachmentReferences, saveHtmlRender } from "../persistence/html-renders";
import { getWorkspace } from "../persistence/workspaces";
import { executionHostService } from "./execution-host-service";
import { getChatExecutionHostBinding } from "./chat-history-export-service";
import { closeCommandExecutor, resolveCommandExecutorDirectory, type CommandExecutor } from "./command-executor";
import { requireControlChat } from "./control-origin";
import type { ControlToolContext } from "./control-tool-context";
import { captureHtmlPreview } from "./html-preview-browser";
import { chatManager } from "./chat-manager";
import { ControlOperationAuthority } from "./control-authority";

type HtmlNode = DefaultTreeAdapterMap["node"];
const isExternal = (value: string) => /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value) && !/^(?:file|attachment):/i.test(value);

async function readFile(executor: CommandExecutor, path: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const metadata = await executor.getFileMetadata(path, { includeContentHash: false, signal });
  if (metadata?.kind !== "file") throw new DomainError("html_resource_unavailable", `File not found on the execution host: ${path}`);
  if (metadata.size > limit) throw new DomainError("html_resource_too_large", `File exceeds the ${limit} byte limit: ${path}`);
  const stream = await executor.streamFile(path, { signal });
  if (!stream) throw new DomainError("html_resource_unavailable", `File could not be read on the execution host: ${path}`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  await stream.pipeTo(new WritableStream<Uint8Array>({
    write(chunk) {
      bytes += chunk.byteLength;
      if (bytes > limit) throw new DomainError("html_resource_too_large", `File exceeds the ${limit} byte limit: ${path}`);
      chunks.push(chunk);
    },
  }), { signal });
  return Buffer.concat(chunks);
}

async function rewriteSrcset(value: string, rewrite: (value: string) => Promise<string>): Promise<string> {
  const candidates: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (/[\s,]/.test(value[index] ?? "") && index < value.length) index++;
    const start = index;
    while (index < value.length && !/\s/.test(value[index]!)) index++;
    const url = value.slice(start, index);
    if (!url) break;
    if (url.endsWith(",")) {
      candidates.push(await rewrite(url.replace(/,+$/, "")));
      continue;
    }
    const descriptorStart = index;
    let parentheses = 0;
    while (index < value.length) {
      const character = value[index]!;
      if (character === "," && parentheses === 0) break;
      if (character === "(") parentheses++;
      if (character === ")") parentheses--;
      index++;
    }
    candidates.push(`${await rewrite(url)}${value.slice(descriptorStart, index)}`);
    index++;
  }
  return candidates.join(", ");
}

async function prepareHtml(context: ControlToolContext, source: HtmlSource) {
  if ((source.html === undefined) === (source.path === undefined)) {
    throw new DomainError("html_source_invalid", "Supply exactly one of html or path.");
  }
  const { actions, origin } = context.options;
  const signal = actions.signal;
  const authority = actions.authority;
  if (!(authority instanceof ControlOperationAuthority)) throw new DomainError("html_chat_unavailable", "HTML tools require an execution-owned control session.");
  const grant = await authority.revalidate();
  if (grant.htmlArtifacts !== 1) throw new DomainError("html_host_unsupported", "Update the execution host to support native HTML preview image results.");
  const chatId = origin?.current.chat;
  if (!chatId || !grant.executionHostBinding) throw new DomainError("html_chat_unavailable", "HTML tools require an active chat execution.");
  await requireControlChat(grant, chatId);
  const chat = await loadChatMetadata(chatId);
  if (!chat) throw new DomainError("html_chat_unavailable", "The originating chat is unavailable.");
  const binding = await getChatExecutionHostBinding({ getWorkspace }, chat);
  if (!executionHostBindingsEqual(binding, grant.executionHostBinding)) throw new DomainError("html_host_changed", "The chat's execution host has changed.");
  const directory = chat.state.session?.binding?.directory ?? chat.state.worktree?.worktreePath ?? chat.config.directory;
  const executor = await executionHostService.getCommandExecutor(binding, {
    directory, operationId: `html:${context.options.requestId}`, localUserId: grant.user.id,
  });
  try {
    const workingDirectory = await resolveCommandExecutorDirectory(executor, directory);
    const path = source.path ? posix.resolve(workingDirectory, source.path) : undefined;
    if (path && !/\.html?$/i.test(path)) throw new DomainError("html_source_invalid", "The source file must have an .html or .htm extension.");
    const html = path ? new TextDecoder("utf-8", { fatal: true }).decode(await readFile(executor, path, HTML_MAX_BYTES, signal)) : source.html!;
    if (Buffer.byteLength(html) > HTML_MAX_BYTES || !/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(html)) {
      throw new DomainError("html_source_invalid", "Use a complete HTML document beginning with <!doctype html> or <html>, at most 25 MiB.");
    }
    const document = parse(html);
    let baseDirectory = path ? posix.dirname(path) : workingDirectory;
    let externalBase = false;
    const unresolved: { reference: string; message: string }[] = [];
    const reportUnresolved = (reference: string, message: string) => {
      if (unresolved.length >= 64) throw new DomainError("html_resource_limit", "Use at most 64 unresolved local resource references.");
      unresolved.push({ reference: reference.slice(0, 400), message: message.slice(0, 400) });
    };
    const images = new Map<string, string>();
    let includedBytes = Buffer.byteLength(html);
    const includeImage = (image: string, original: string): string => {
      includedBytes += Buffer.byteLength(image) - Buffer.byteLength(original);
      if (includedBytes > HTML_MAX_BYTES) throw new DomainError("html_resource_limit", "The prepared HTML exceeds 25 MiB.");
      return image;
    };
    const nodes: HtmlNode[] = [];
    const visit = (node: HtmlNode) => {
      nodes.push(node);
      if ("childNodes" in node) node.childNodes.forEach(visit);
      if ("content" in node) visit(node.content);
    };
    visit(document);
    for (const node of nodes) {
      if (!("tagName" in node) || node.tagName !== "base") continue;
      const href = node.attrs.find((attribute) => attribute.name === "href");
      if (!href) continue;
      externalBase = isExternal(href.value);
      if (!externalBase) {
        const base = new URL(href.value, pathToFileURL(`${baseDirectory}/`));
        baseDirectory = fileURLToPath(new URL(".", base));
        node.attrs = node.attrs.filter((attribute) => attribute.name !== "href");
      }
      break;
    }
    const isLocalResource = (value: string) => !isExternal(value)
      && (!externalBase || /^(?:file|attachment):/i.test(value));
    const rewrite = async (value: string): Promise<string> => {
      const reference = value.trim();
      if (!reference || !isLocalResource(reference)) return value;
      const cached = images.get(reference);
      if (cached) return includeImage(cached, value);
      if (images.size >= 64) throw new DomainError("html_resource_limit", "Use at most 64 distinct local image references.");
      try {
        let bytes: Uint8Array;
        if (reference.startsWith("attachment:")) {
          const selector = reference.slice("attachment:".length);
          const slash = selector.indexOf("/");
          let messageId: string;
          let attachmentId: string;
          if (slash >= 0) {
            messageId = selector.slice(0, slash);
            attachmentId = selector.slice(slash + 1);
          } else {
            const matches = listHtmlAttachmentReferences(chatId, selector);
            if (matches.length !== 1) throw new DomainError("html_resource_unavailable", `Attachment filename is missing or ambiguous: ${selector}. Use an exact attachment reference from availableAttachments.`);
            ({ messageId, attachmentId } = matches[0]!);
          }
          const message = getChatMessageFromTranscript(chatId, messageId);
          const attachment = message?.attachments?.find((item) => item.id === attachmentId);
          if (!attachment) throw new DomainError("html_resource_unavailable", `Attachment not found in this chat: ${reference}`);
          if (attachment.size > HTML_IMAGE_MAX_BYTES) throw new DomainError("html_resource_too_large", `Attachment exceeds 10 MiB: ${reference}`);
          bytes = Buffer.from(attachment.data, "base64");
        } else {
          const file = reference.startsWith("file:") ? fileURLToPath(reference) : decodeURIComponent(reference.split(/[?#]/, 1)[0]!);
          bytes = await readFile(executor, posix.resolve(baseDirectory, file), HTML_IMAGE_MAX_BYTES, signal);
        }
        const mimeType = detectBrowserImageMimeType(bytes);
        if (!mimeType || bytes.byteLength > HTML_IMAGE_MAX_BYTES) throw new DomainError("html_image_invalid", `Not a supported image of at most 10 MiB: ${reference}`);
        const fragment = mimeType === "image/svg+xml" && !reference.startsWith("attachment:") && reference.includes("#")
          ? reference.slice(reference.indexOf("#")) : "";
        const embedded = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}${fragment}`;
        images.set(reference, embedded);
        return includeImage(embedded, value);
      } catch (error) {
        if (!(error instanceof DomainError) || !["html_resource_unavailable", "html_resource_too_large", "html_image_invalid"].includes(error.code)) throw error;
        reportUnresolved(reference, error.message);
        const placeholder = "about:blank#unresolved-local-image";
        images.set(reference, placeholder);
        return includeImage(placeholder, value);
      }
    };
    const rewriteCss = async (value: string, styleAttribute: boolean) => {
      const tree = parseCss(value, { context: styleAttribute ? "declarationList" : "stylesheet" });
      const urls: Url[] = [];
      const imports = new Set<StringNode | Url>();
      walkCss(tree, (node) => {
        if (node.type === "Url") urls.push(node);
        if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
          const resource = node.prelude?.type === "AtrulePrelude" ? node.prelude.children.first : undefined;
          if (resource?.type === "String" || resource?.type === "Url") imports.add(resource);
        }
      });
      for (const resource of imports) {
        if (!resource.value || !isLocalResource(resource.value)) continue;
        reportUnresolved(resource.value, "Only local images are embedded. Inline this stylesheet or use an external URL.");
        resource.value = "about:blank#unresolved-local-resource";
      }
      for (const node of urls) node.value = await rewrite(node.value);
      return generateCss(tree);
    };
    for (const node of nodes) {
      signal.throwIfAborted();
      if (!("tagName" in node)) continue;
      for (const attribute of node.attrs) {
        if (attribute.name === "style") attribute.value = await rewriteCss(attribute.value, true);
        else if (attribute.name === "srcset" && ["img", "source"].includes(node.tagName)) attribute.value = await rewriteSrcset(attribute.value, rewrite);
        else if ((attribute.name === "src" && ["img", "source"].includes(node.tagName))
          || (attribute.name === "poster" && node.tagName === "video")
          || (attribute.name === "href" && node.tagName === "image")) attribute.value = await rewrite(attribute.value);
        else if ((attribute.name === "src" && ["script", "iframe", "video", "audio"].includes(node.tagName))
          || (attribute.name === "href" && node.tagName === "link")) {
          if (attribute.value && isLocalResource(attribute.value)) {
            reportUnresolved(attribute.value, "Only local images are embedded. Inline this resource or use an external URL.");
            attribute.value = "about:blank#unresolved-local-resource";
          }
        }
      }
      if (node.tagName === "style") {
        for (const child of node.childNodes) if (child.nodeName === "#text" && "value" in child) child.value = await rewriteCss(child.value, false);
      }
    }
    const prepared = bootstrapHtml(serialize(document));
    if (Buffer.byteLength(prepared) > HTML_MAX_BYTES) throw new DomainError("html_resource_limit", "The prepared HTML exceeds 25 MiB.");
    return { html: prepared, chatId, scope: chat.config.scope, authority, unresolved, availableAttachments: listHtmlAttachmentReferences(chatId) };
  } finally {
    closeCommandExecutor(executor);
  }
}

export async function executeHtmlTool(context: ControlToolContext, name: "clanky_html_preview" | "clanky_html_render", input: unknown): Promise<unknown> {
  if (name === "clanky_html_preview") {
    const options = HtmlPreviewInputSchema.parse(input);
    const prepared = await prepareHtml(context, options);
    const { data, ...preview } = await captureHtmlPreview({ ...options, html: prepared.html, signal: context.options.actions.signal });
    return {
      kind: "clanky_image_result",
      result: { ok: true, ...preview, unresolvedImages: prepared.unresolved, availableAttachments: prepared.availableAttachments },
      images: [{ mimeType: "image/png", data }],
    };
  }
  const options = HtmlRenderInputSchema.parse(input);
  const prepared = await prepareHtml(context, options);
  if (prepared.unresolved.length) throw new DomainError("html_resources_unresolved", prepared.unresolved.map((item) => `${item.reference}: ${item.message}`).join("\n").slice(0, 10_000));
  await prepared.authority.revalidate();
  context.options.actions.signal.throwIfAborted();
  const reference = { id: crypto.randomUUID(), chatId: prepared.chatId, title: options.title, height: options.height };
  const log = saveHtmlRender(reference, prepared.html);
  chatManager.emitPublishedHtmlRender(prepared.chatId, prepared.scope, log);
  return { ok: true, htmlRender: reference };
}
