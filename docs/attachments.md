# Conversation attachments

Attach any file to a chat, task input or manual Agent run. The picker accepts
all extensions and MIME types. File paste works when the browser exposes actual
files; ordinary clipboard text still inserts text. Browsers may not expose
every operating-system clipboard format.

Limits are unchanged: 20 attachments per message, 20 MiB per file and 60 MiB
combined per provider turn, including grouped queued input and steering.
Empty non-image files are supported.

## What the agent receives

PNG, JPEG, WebP and GIF retain their inline image behavior and previews. Other
image formats, such as SVG and HEIC, are ordinary files.

Every other attachment, including TXT, Markdown, PDF, office documents, archives
and files without a known MIME type, is copied byte-for-byte to the agent's
execution host. Its prompt receives the original filename and absolute path,
plus the conversation's attachment directory for later turns. Clanky does not
extract text, run OCR, summarize, convert, unpack or execute uploads.

This works independently of provider-native document support. The agent must
use its own tools to open the file; Clanky cannot guarantee that every model
can understand every format.

## Location and privacy

Files live below the conversation's actual execution directory:

```text
<execution-directory>/.clanky-attachments/<owned-context>/<message>/<slot>/<safe-filename>
```

A task or chat using a worktree uses that worktree. A conversation without Git
uses its selected directory. SSH and Mesh transfers write on the selected
execution host, not implicitly on the Clanky controller. Authentication and
execution-host binding checks still apply.

Context/message/slot identifiers are generated independently of supplied names.
Names are made filesystem-safe without changing the bytes or saved original
filename. Identical names in different messages or conversations do not
overwrite each other. Git repositories exclude the managed folder locally
through `info/exclude`; Clanky does not modify the project's `.gitignore`.

API and persisted originals are private per user. Host copies use the
permissions of the execution account: this directory is not a sandbox against
other processes or agents running as that account. The ordinary workspace
filesystem navigation and symbolic-link rules remain unchanged.

## Persistence, downloads and deletion

Original bytes remain with the persisted input/history. Clicking a non-image
file in the transcript downloads that original without rendering active HTML
or SVG. An agent's edits to its working copy do not alter the download.

Files survive later turns, disconnects, stops and server restarts. Missing
working copies are recreated from persisted originals before the next prompt;
existing copies are not overwritten, preserving agent edits. Recovery-history
exports point to durable files instead of deleting them with a temporary export.

Moving a chat to Trash retains originals and working copies. Permanent deletion
cleans only that conversation's managed directories on their recorded hosts.
An unavailable host leaves ordinary chat deletion in Trash for retry. Workspace
deletion retains its existing best-effort remote cleanup policy.

Logical task deletion retains attachments for revival; permanent task purge
includes managed-file cleanup in the existing deferred cleanup process. Remote
cleanup failures are logged and must not be interpreted as proof that the
remote files disappeared.

Write or connection failures stop file preparation before provider admission.
No inline-document fallback is attempted, and queued originals remain available
for correction/retry. Password-protected registered SSH hosts require their
normal transient credential tokens; credentials are never stored with attachments.

Markdown/HTML transcript exports do not embed original attachment bytes.
Chat-to-task conversion retains descriptive references, not a transfer of the
original uploads. Plan-file import remains a separate operation.
