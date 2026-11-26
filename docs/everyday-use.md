# Get the most out of Clanky: Mac to iPhone

Run Clanky on your computer and follow your projects from the Mac app, a browser
or your iPhone. Tailscale lets you take that same workspace with you, and Quick
Chat makes starting a new conversation a single click.

Start with a project folder and an agent you already use, installed and signed
in on your computer. Choose GitHub Copilot, Codex, OpenCode 2 or Claude Agent;
the [agent setup guide](harnesses.md#workspace-configuration) has instructions
for each.

## 1. Start Clanky

### With the Mac app

Download the Mac app from the
[latest release](https://github.com/pablozaiden/clanky/releases/latest),
unzip it, move `Clanky.app` to Applications and open it.

1. Create your account through **Local Controller > Initialize Owner
   Password...**. Choose a username and a password of at least 12 characters.
2. Choose **Local Controller > Start Local Controller**.
3. Follow the sign-in page that opens in your browser, sign in with your
   password and approve the connection. Return to Clanky.

The app remembers this setup and starts your controller the next time you open
Clanky. Keep the app running while you use it from another device.

To also use the bundled CLI from Terminal, choose **Clanky > Install Command
Line Tool...**. If `clanky` is already available in your shell's PATH, nothing
changes. Otherwise, confirm to create `~/.local/bin/clanky` as a link to the
app's CLI, without administrator privileges. The app adds that directory to
your zsh or bash startup file only if needed; other shells receive manual
PATH instructions. Existing files or installations are not overwritten.
Open a new Terminal session afterward and run `clanky version`.

Keep the app in its current location: moving or deleting it breaks the link.
Update this CLI by updating the app, not with CLI self-update. Terminal commands
use the regular CLI configuration and data, not the app-owned controller's
private configuration; installing the command does not connect it to that
controller.

### From Terminal

Install Clanky:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/installer/main/install.sh \
  | sh -s -- pablozaiden/clanky
export PATH="$HOME/.local/bin:$PATH"
```

Then start it:

```bash
clanky serve
```

Open <http://localhost:3000> and follow **Create owner user**. Add a password
under **Settings > Account & access > Security > Password** to sign in from
your other devices.

## 2. Create your first workspace and chat

A workspace brings together your project and its conversations.

1. Open **Workspaces** and create a workspace with **Manual** setup.
2. Give it a name and enter your project folder in **Directory**. Choose **Git
   repository**, **Multiple Git repositories**, or **Directory**.
3. Choose your computer as the **Execution host** and select **GitHub Copilot**,
   **Codex**, **OpenCode 2** or **Claude Agent** under **Adapter**. Test the
   connection and create the workspace.

Open **New Chat** from the workspace's menu and choose a model. Use worktrees
to give independent coding tasks their own working copy.

For larger changes, select **Start with a plan** and describe the result you
want. For example:

```text
Review the sign-in flow and propose a simpler experience for new users.
Show me the plan so we can discuss it before implementation.
```

Read **Plan** and **Status**, discuss the proposal, then send "Implement this
plan" when you're happy with it. Use **Diff** to review the changes.

### Work across several repositories

Choose **Multiple Git repositories** for a non-Git directory with repositories
in its immediate subdirectories. The directory can start empty; clone into it
from the workspace terminal. Clanky discovers the repositories when you open
the repository list or create a chat. Existing chats keep their original group.

A chat starts in its own directory with a new branch and worktree for each
repository and a private copy of every file directly in the workspace root,
including dotfiles. Non-repository subdirectories are not copied. Files outside
the repositories are not part of a Git diff and do not sync back to the
workspace. In **New Chat**, use **Base branches** to override
the default for individual repositories. Set recurring choices under
**Workspace settings > General > Default base branches**. Select a repository
in **Diff** to review its changes, branch and pull request.

When a base tracks a remote branch, Clanky also tries to fast-forward the
existing local branch in the original repository. It never switches branches,
overwrites local changes, or modifies a branch checked out in another
worktree. If it cannot update a branch safely, the chat reports the reason
and still uses the selected base. Quick Chat skips this synchronization.

**New Chat here** shares the current chat's directory instead of making a copy.
Permanently delete chats that share it before purging the original. Remove
existing chats and automation runs before moving a workspace to another host.

## 3. Connect through Tailscale

Install [Tailscale](https://tailscale.com/download) on your computer and iPhone,
and sign in to the same Tailscale network on both.

### From the Mac app

1. Choose **Local Controller > Network Access...**.
2. Select **Automatic Remote Access (Tailscale)** and **Apply and Restart**.
3. Follow **Finish Tailscale Setup...** if it appears.
4. When you see **Available via Tailscale**, choose **Copy Remote Link**.

### From a manual controller

Follow the [manual Tailscale setup](deployment.md#tailscale-serve) to get your
remote HTTPS address. Keep Clanky and Tailscale Serve running.

Keep your computer awake and connected to Tailscale while working remotely.

## 4. Open Clanky in a browser or on iPhone

In a **browser**, open the
[Clanky browser client](https://pablozaiden.github.io/clanky/stable/api/)
and enter your remote link. This also works in Safari on your iPhone.

In the **iPhone app**, choose **Connect to an API** and paste the same link.

Follow the sign-in page, use your account password, check the displayed code
and approve the connection. Your workspaces and conversations are ready to use.

Try starting a chat on your Mac and continuing it from your phone. Keep the
iPhone app open during voice calls and file transfers.

## 5. Make Quick Chat a one-click habit

In the in-app **Settings > Chats > Quick Chat**:

1. Select the **Workspace** you use most.
2. Choose its **Model**.
3. Enable **Use worktrees for quick chats** if you want each quick task to have
   its own working copy.

Your choices save as you go. Use **Start Quick Chat** in the sidebar whenever
you want a fresh conversation with those settings, on Mac or iPhone.
When changing the Quick Chat workspace, choose its model again.

## 6. Choose text models and add voice

Choose a text model from your workspace's agent when creating a chat. Change it
under **Model** in the composer options between responses. A faster model is
handy for small requests; a more capable one is useful for planning and reviewing
larger changes.

To add voice, open **Settings > Voice**, enter your provider URL and API key,
and fill in the model names for the features you want:

| Setting | Use it for |
| --- | --- |
| **Transcription** | Dictate a message with **Talk** |
| **Text generation** | Listen to summaries, translate responses and support Live Voice |
| **Live Voice** | Talk to Clanky about your workspaces and chats |

Choose **Save**, then **Validate** beside each model you configured. The
[Voice setup guide](voice.md#provider-settings) has provider-specific help.

Use **Talk** from the composer options when you're ready to dictate a new
message. Stop the recording to transcribe and send it.

Start **Live Voice** from the sidebar microphone beside Quick Chat. Try
"Which chats need my input?" or "Open my project workspace." Review and approve
actions when Clanky asks. Allow microphone access when your device prompts you.

Under **Live Voice > Personal instructions**, set your preferred language and
style, for example: "Speak Spanish and keep answers short."

## Useful habits

Pin your favorite workspaces and chats, and give conversations recognizable
names. Home's **Needs attention** brings questions and approvals together.

Save recurring prompts in **Settings > Content > Templates**, and keep project
notes in [Scratchpad](scratchpad.md). Use **Code Explorer** to browse files and
attach screenshots or documents to give your agent useful context.

Use **Activity** to follow background work and **Diff** to review results.
Set up **Automations** for recurring tasks. If you use
[Listen](control-chats.md#agent-notifications), choose the alerts you want under
**Settings > Agents & integrations > Notifications**.

## Compare client performance

In **Settings > About > Performance Stats**, enable **Capture performance**.
Capture stays enabled after reload; the timeline is kept only in the current
page. **Hide** closes the floating panel without stopping capture. Use
**Export JSON** before reloading again or turning capture off.

For a comparison, use the same Clanky build, controller, and chat on both
clients. After opting in, reload or relaunch each client, then leave the
chat in the background for the same interval. Create a transcript update
from another client while it is hidden, return, and export one capture from
each client. Repeat without an update for a baseline. Note the client and
network conditions separately; the JSON does not include server addresses,
account identifiers, chat content, or credentials.

Startup ends when Home or the active chat has had a chance to paint. Foreground
realtime confirmation and the first observed visible update are separate
measurements. A reused connection is confirmed by existing WebSocket traffic;
confirmation can include waiting for the next scheduled heartbeat. An unchanged
chat snapshot means a read completed without a new transcript position. If no
confirmation or update is observed, don't treat its absence as zero latency.
HTTP wait includes server and network time; WebSocket RTT is round-trip time,
not one-way latency.

To compare chat opening, start on Home and select the same chat on each client.
Switch away and repeat to compare first and repeated openings. **Chat open**
measures the selection through the first paint opportunity of the initial
conversation, including an empty conversation. It does not wait for older
messages or attachments. In JSON `chat-open` samples, `transcriptSource` is
`available` when the initial transcript was already present or `snapshot`
when an initial read was needed. `snapshotMs` reports the time spent awaiting
and decoding that snapshot after selection. This does not identify the
browser's HTTP cache.

In a chat with Clanky control tools, ask the agent to analyze the Performance
Stats from this client. It reads the active capture from the tab that sent
your message, without starting capture or prompting again. Ask for recent
samples when the summary is not enough. The selected stats are shared with
the chat's agent. Export JSON for the full retained trace or to compare two
clients in one chat.
